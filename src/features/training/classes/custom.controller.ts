import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UploadedFile,
  UseInterceptors,
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
import { ClassesService as Service } from './service';
// Import utils specifics
import { FileInterceptor } from '@nestjs/platform-express';
import {
  getMulterOptions,
  getOptimizedMulterOptions,
} from '../../upload/upload.middleware';
import { ImageOptimizationInterceptor } from '../../upload/image-optimization.interceptor';
// Import generic controller
import { Public } from 'src/auth/decorators/public.decorator';
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
  ) {
  }

  // ROTA PÚBLICA PARA VALIDAR ALUNO PELO CPF E CÓDIGO DA TURMA
  @Public()
  @Post('validate-student')
  @UseInterceptors(FileInterceptor('image', getMulterOptions('classes-image')))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async validateStudent(@Body() validateDto: ValidateStudentDto): Promise<any> {
    const { cpf, classCode, classId } = validateDto;
    return this.Service.validateStudent(cpf, classCode, classId);
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
}