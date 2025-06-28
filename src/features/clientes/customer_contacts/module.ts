import { Module } from '@nestjs/common';
import { CustomerContactsController as Controller } from './controller';
import { CustomerContactsService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class CustomerContactsModule {}
