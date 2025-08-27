import { Module } from '@nestjs/common';
import { TraineeCertificateController as Controller } from './controller';
import { TraineeCertificateService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
  exports: [Service],
})
export class TraineeCertificateModule {}
