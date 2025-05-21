import { Module } from '@nestjs/common';
import { CourseClassInstructorController as Controller } from './controller';
import { CourseClassInstructorService as Service } from './service';
import { UploadModule } from '../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class CourseClassInstructorModule {}
