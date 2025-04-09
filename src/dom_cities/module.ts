import { Module } from '@nestjs/common';
import { DomCitiesController as Controller } from './controller';
import { DomCitiesService as Service } from './service';
import { UploadModule } from '../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class DomCitiesModule {}
