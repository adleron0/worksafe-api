import { Module } from '@nestjs/common';
import { CompanygatewaysController as Controller } from './controller';
import { CompanygatewaysService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class CompanygatewaysModule {}
