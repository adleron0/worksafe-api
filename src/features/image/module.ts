import { Module } from '@nestjs/common';
import { ImageController as Controller } from './controller';
import { ImageService as Service } from './service';
import { UploadModule } from '../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class ImageModule {}
