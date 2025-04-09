import { Module } from '@nestjs/common';
import { DomRanksController as Controller } from './controller';
import { DomRanksService as Service } from './service';
import { UploadModule } from '../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class DomRanksModule {}
