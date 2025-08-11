import { Module } from '@nestjs/common';
import { ExamesController as Controller } from './controller';
import { ExamesService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class ExamesModule {}
