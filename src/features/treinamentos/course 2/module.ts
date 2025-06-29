import { Module } from '@nestjs/common';
import { CourseController as Controller } from './controller';
import { CourseService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class CourseModule {}
