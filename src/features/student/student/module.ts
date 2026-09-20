import { Module } from '@nestjs/common';
import { UploadModule } from '../../upload/upload.module';
import { StudentService as Service } from './service';

@Module({ providers: [Service], imports: [UploadModule], controllers: [], exports: [Service] })
export class StudentModule {}
