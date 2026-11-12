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
  BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
// Import entity template
import { SendCertificateEmailDto } from './dto/send-email.dto';
import { TraineeCertificateService as Service } from './service';
// Import utils specifics
import { FileInterceptor } from '@nestjs/platform-express';
import { getMulterOptions } from '../../upload/upload.middleware';
// Import cache
import { Cache, CacheEvictAll } from 'src/common/cache';
import { CacheService } from 'src/common/cache/cache.service';
// Import de configuraões

function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: 'TraineeCourseCertificate' as keyof PrismaClient,
  name: 'TraineeCertificate',
  route: 'trainee-certificate',
  permission: 'classes',
};

@Controller('trainee-certificate')
export class TraineeCertificateCustomController {
  constructor(
    private readonly Service: Service,
    // cacheService é usado pelos decorators de cache
    private readonly cacheService: CacheService,
  ) {
  }


  // Não é usada por nenhuma das telas públicas de certificado (que só leem
  // via GET /public) — disparar reenvio de e-mail deve exigir autenticação.
  @UserPermission(`update_${entity.permission}`)
  @Post('send-email')
  @UseInterceptors(FileInterceptor('none')) // Interceptor para processar FormData
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async sendCertificateByEmail(@Body() dto: SendCertificateEmailDto) {
    return this.Service.sendCertificateByEmail(
      dto.traineeId,
      dto.certificateKey,
    );
  }

  // Era pública para a página pública de certificado salvar a thumbnail gerada
  // no navegador do primeiro visitante (useAutoGenerateThumbnail). Esse fluxo
  // foi desligado no front (editor do certfield, 11/11/2026) e a rota ficou sem
  // consumidor — mantê-la pública só deixava qualquer visitante trocar a imagem
  // de preview de um certificado. A thumbnail passará a ser gerada no backend
  // (plano de render de certificados na API); até lá, só quem tem permissão atualiza.
  @UserPermission(`update_${entity.permission}`)
  @Put('update-pdf/:id')
  @UseInterceptors(
    FileInterceptor('image', getMulterOptions('trainee-certificate-pdf')),
  )
  async updatePdfUrl(
    @Param('id') id: number,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    if (!file) {
      throw new BadRequestException('Arquivo de imagem é obrigatório');
    }

    return this.Service.updatePdfUrl(Number(id), file.location);
  }
}