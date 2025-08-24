import { Module, forwardRef } from '@nestjs/common';
import { SubscriptionController as Controller } from './controller';
import { SubscriptionService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';
import { CacheModule } from 'src/common/cache';
import { CheckoutModule } from 'src/features/gateway/checkout/checkout.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule, CacheModule, forwardRef(() => CheckoutModule)],
})
export class SubscriptionModule {}
