import { Module } from '@nestjs/common';
import { OnlinecoursesController as Controller } from './controller';
import { OnlinecoursesService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class OnlinecoursesModule {}
