import { Module } from '@nestjs/common';
import { ImageService as Service } from './service';
import { UploadModule } from '../upload/upload.module';

/** CRUD e rotas custom vivem no CrudModule; aqui só o service. */
@Module({ providers: [Service], imports: [UploadModule], exports: [Service] })
export class ImageModule {}
