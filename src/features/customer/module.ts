import { Module } from '@nestjs/common';
import { CustomerController as Controller } from './controller';
import { CustomerService as Service } from './service';
import { UploadModule } from '../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class CustomerModule {}
