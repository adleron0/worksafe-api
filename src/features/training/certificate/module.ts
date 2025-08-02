import { Module } from '@nestjs/common';
import { CertificateController as Controller } from './controller';
import { CertificateService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class CertificateModule {}
