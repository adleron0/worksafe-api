import { Module } from '@nestjs/common';
import { CommentController as Controller } from './controller';
import { CommentService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';
import { BlogAuthModule } from '../auth/auth.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule, BlogAuthModule],
})
export class CommentModule {}
