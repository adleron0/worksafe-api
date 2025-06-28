import { Module } from '@nestjs/common';
import { SiteProductsController as Controller } from './controller';
import { SiteProductsService as Service } from './service';
import { UploadModule } from '../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class SiteProductsModule {}
