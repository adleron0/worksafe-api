import { Module } from '@nestjs/common';
import { CompanygatewaysController as Controller } from './controller';
import { CompanygatewaysService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';
import { PaymentsModule } from 'src/payments/payments.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule, PaymentsModule],
})
export class CompanygatewaysModule {}
