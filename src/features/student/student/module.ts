import { Module } from '@nestjs/common';
import { StudentController as Controller } from './controller';
import { StudentService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class StudentModule {}
