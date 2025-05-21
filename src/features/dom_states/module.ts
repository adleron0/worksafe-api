import { Module } from '@nestjs/common';
import { DomStatesController as Controller } from './controller';
import { DomStatesService as Service } from './service';
import { UploadModule } from '../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class DomStatesModule {}
