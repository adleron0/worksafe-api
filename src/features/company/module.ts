import { Module } from '@nestjs/common';
import { CompanyController as Controller } from './controller';
import { CompanyService as Service } from './service';
import { UploadModule } from '../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class CompanyModule {}
