import { Module } from '@nestjs/common';
import { CommentController as Controller } from './controller';
import { CommentService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class CommentModule {}
