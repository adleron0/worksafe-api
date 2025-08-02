import { Module } from '@nestjs/common';
import { ProfileController as Controller } from './controller';
import { ProfileService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class ProfileModule {}
