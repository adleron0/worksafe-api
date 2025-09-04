import { Module } from '@nestjs/common';
import { OnlinelessonController as Controller } from './controller';
import { OnlinelessonService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class OnlinelessonModule {}
