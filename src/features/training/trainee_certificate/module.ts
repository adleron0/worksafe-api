import { Module } from '@nestjs/common';
import { UploadModule } from 'src/features/upload/upload.module';
import { EmailModule } from 'src/features/email/email.module';
import { TraineeCertificateService as Service } from './service';
import { ShareCardService } from './share-card.service';
import { CertificateRenderService } from './render/certificate-render.service';

@Module({
  providers: [Service, ShareCardService, CertificateRenderService],
  imports: [UploadModule, EmailModule],
  exports: [Service, ShareCardService, CertificateRenderService],
})
export class TraineeCertificateModule {}
