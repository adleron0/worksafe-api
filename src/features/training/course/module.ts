import { Module } from '@nestjs/common';
import { UploadModule } from 'src/features/upload/upload.module';
import { CourseService as Service } from './service';

/** CRUD vive no CrudModule; aqui só o service (rotas custom / outros módulos). */
@Module({ providers: [Service], imports: [UploadModule], exports: [Service] })
export class CourseModule {}
