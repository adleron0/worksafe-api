import { Module } from '@nestjs/common';
import { ReviewsController as Controller } from './controller';
import { ReviewsService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class ReviewsModule {}
