import { Module } from '@nestjs/common';
import { ServicesController as Controller } from './controller';
import { ServicesService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class ServicesModule {}
