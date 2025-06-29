import { Module } from '@nestjs/common';
import { InstructorController as Controller } from './controller';
import { InstructorService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class InstructorModule {}
