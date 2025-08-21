import { Module } from '@nestjs/common';
import { FinancialrecordsController as Controller } from './controller';
import { FinancialrecordsService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class FinancialrecordsModule {}
