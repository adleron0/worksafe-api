import { Module } from '@nestjs/common';
import { OnlinelessonstepController as Controller } from './controller';
import { OnlinelessonstepService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class OnlinelessonstepModule {}
