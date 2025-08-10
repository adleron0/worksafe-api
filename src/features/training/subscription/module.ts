import { Module } from '@nestjs/common';
import { SubscriptionController as Controller } from './controller';
import { SubscriptionService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';
import { CacheModule } from 'src/common/cache';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule, CacheModule],
})
export class SubscriptionModule {}
