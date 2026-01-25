import { Module } from '@nestjs/common';
import { VisitorController as Controller } from './controller';
import { VisitorService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class VisitorModule {}
