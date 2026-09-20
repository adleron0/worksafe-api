import { Module } from '@nestjs/common';
import { UploadModule } from 'src/features/upload/upload.module';
import { EmailModule } from 'src/features/email/email.module';
import { TraineeCertificateService as Service } from './service';

@Module({ providers: [Service], imports: [UploadModule, EmailModule], exports: [Service] })
export class TraineeCertificateModule {}
