import { Module } from '@nestjs/common';
import { UploadModule } from 'src/features/upload/upload.module';
import { TraineeCertificateModule } from '../trainee_certificate/module';
import { ClassesService as Service } from './service';

@Module({ providers: [Service], imports: [UploadModule, TraineeCertificateModule], exports: [Service] })
export class ClassesModule {}
