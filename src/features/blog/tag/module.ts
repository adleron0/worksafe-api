import { Module } from '@nestjs/common';
import { TagController as Controller } from './controller';
import { TagService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class TagModule {}
