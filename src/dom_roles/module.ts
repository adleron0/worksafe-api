import { Module } from '@nestjs/common';
import { DomRolesController as Controller } from './controller';
import { DomRolesService as Service } from './service';
import { UploadModule } from '../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class DomRolesModule {}
