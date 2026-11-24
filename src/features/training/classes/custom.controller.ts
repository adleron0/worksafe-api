import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UsePipes,
  ValidationPipe,
  Query,
  applyDecorators,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
// Import entity template
import { ValidateStudentDto } from './dto/validate-student.dto';
import { GenerateCertificatesSelectiveDto } from './dto/generate-certificates-selective.dto';
import { ClassesService as Service } from './service';
// Import generic controller
import { Public } from 'src/auth/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';
import { PublicFormFields } from '../public-form';
import { openExamSession } from '../exames/exam-session';
import { Cache, CacheEvictAll } from 'src/common/cache';
import { CacheService } from 'src/common/cache/cache.service';

// Create a decorator factory for User controller permissions
function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: 'courseClass' as keyof PrismaClient,
  name: 'Classes',
  route: 'classes',
  permission: 'classes',
};

@Controller('classes')
export class ClassesCustomController {
  constructor(
    private readonly Service: Service,
    // cacheService é usado pelos decorators de cache
    private readonly cacheService: CacheService,
  ) {}

  // ROTA PÚBLICA PARA VALIDAR ALUNO PELO CPF E CÓDIGO DA TURMA
  // Throttle baixo: o código da turma tem 4 caracteres e, com um CPF, a rota
  // responde se o par confere. Sem upload (nunca usou o arquivo); o front
  // manda multipart, então fica o parser só de campos.
  @Public()
  @Post('validate-student')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @PublicFormFields()
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async validateStudent(@Body() validateDto: ValidateStudentDto): Promise<any> {
    const { cpf, classCode, classId } = validateDto;
    const result = await this.Service.validateStudent(cpf, classCode, classId);
    // Abre a sessão de prova que o POST /exames/register exige.
    await openExamSession(
      this.cacheService,
      Number(result.traineeId),
      Number(result.classId),
    ).catch((error) =>
      console.error(
        '[validate-student] sessão de prova não gravada:',
        error?.message,
      ),
    );
    return result;
  }

  // Candidatos a aluno destaque da turma, com a nota da prova (sugestão)
  @UserPermission(`list_${entity.permission}`)
  @Get(':id/highlight-candidates')
  async highlightCandidates(@Param('id') id: string, @Req() request: Request) {
    return this.Service.highlightCandidates(
      Number(id),
      Number(request.user.companyId),
    );
  }

  // Alunos para emitir certificados (inscrições confirmadas + situação de cada um)
  @UserPermission(`list_${entity.permission}`)
  @Get(':id/certificate-issuance')
  async certificateIssuance(@Param('id') id: string, @Req() request: Request) {
    return this.Service.certificateIssuance(
      Number(id),
      Number(request.user.companyId),
    );
  }

  // ROTA PARA GERAR CERTIFICADOS PARA TODOS OS ALUNOS DE UMA TURMA
  @UserPermission(`create_${entity.permission}`) // Requer permissão de criar
  @CacheEvictAll('training-classes:*', 'cache:*/classes*')
  @Post('generate-certificates/:id')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async generateCertificates(
    @Param('id') id: number,
    @Req() request: Request,
  ): Promise<any> {
    const userId = request.user.sub || 0;
    const companyId = request.user.companyId || 0;

    return this.Service.generateCertificates(Number(id), userId, companyId);
  }

  // ROTA PARA GERAR CERTIFICADOS SÓ PARA AS INSCRIÇÕES SELECIONADAS
  // (vinda do certfield). Atualiza certificado existente preservando a data
  // de vencimento e não exige exame — quem seleciona é o gestor da turma.
  @UserPermission(`create_${entity.permission}`)
  @CacheEvictAll('training-classes:*', 'cache:*/classes*')
  @Post('generate-certificates-selective/:id')
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async generateCertificatesSelective(
    @Param('id') id: number,
    @Req() request: Request,
    @Body() dto: GenerateCertificatesSelectiveDto,
  ): Promise<any> {
    const companyId = request.user.companyId || 0;
    return this.Service.generateCertificatesSelective(
      Number(id),
      companyId,
      dto.subscriptionIds,
    );
  }
}
