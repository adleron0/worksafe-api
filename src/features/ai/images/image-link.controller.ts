import { Controller, Get, Param, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import * as multer from 'multer';
import { Public } from 'src/auth/decorators/public.decorator';
import { ImageIntakeService } from './image-intake.service';

const UPLOAD = { storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 20 } };

/**
 * Página pública de envio de imagens (link gerado pelo assistente). A
 * autenticação é o próprio token do link: vale 30 minutos e aceita poucas
 * imagens. Fica fora do login para abrir até no celular sem entrar.
 */
@Controller('ai/upload-links')
export class ImageLinkController {
  constructor(private readonly images: ImageIntakeService) {}

  @Public() @Get(':token')
  describe(@Param('token') token: string) { return this.images.describeLink(token); }

  @Public() @Post(':token/images')
  @UseInterceptors(FilesInterceptor('files', 20, UPLOAD))
  upload(@Param('token') token: string, @UploadedFiles() files?: Array<{ buffer: Buffer; originalname: string; mimetype: string }>) {
    return this.images.addToLink(token, files ?? []);
  }
}
