import { Module } from '@nestjs/common';
import { CompanygatewaysController as Controller } from './controller';
import { CompanygatewaysService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';
import { AsaasModule } from 'src/common/gateways/asaas/asaas.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule, AsaasModule],
})
export class CompanygatewaysModule {}
