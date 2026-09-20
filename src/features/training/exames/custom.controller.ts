import { Body, Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Public } from 'src/auth/decorators/public.decorator';
import { getMulterOptions } from 'src/features/upload/upload.middleware';
import { ExamesService } from './service';

/** Registro público de prova (validado pela inscrição confirmada, no service). */
@Controller('exames')
export class ExamesCustomController {
  constructor(private readonly exames: ExamesService) {}
  @Public() @Post('register')
  @UseInterceptors(FileInterceptor('image', getMulterOptions('exames-image')))
  register(@Body() dto: Record<string, any>, @UploadedFile() file?: Express.MulterS3.File) {
    if (file) dto.imageUrl = file.location;
    return this.exames.registerExam(dto as never, { model: 'courseClassExam', name: 'Prova' } as never);
  }
}
