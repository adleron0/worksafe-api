import { Module } from '@nestjs/common';
import { SplitsController as Controller } from './controller';
import { SplitsService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class SplitsModule {}
