import { Module } from '@nestjs/common';
import { ClassAttendanceListController as Controller } from './controller';
import { ClassAttendanceListService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class ClassAttendanceListModule {}
