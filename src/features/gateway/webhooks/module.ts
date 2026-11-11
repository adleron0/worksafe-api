import { PaymentsModule } from 'src/payments/payments.module';
import { Module, forwardRef } from '@nestjs/common';
import { WebhooksController } from './controller';
import { WebhooksService } from './service';
import { CheckoutModule } from '../checkout/checkout.module';

@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService],
  imports: [forwardRef(() => CheckoutModule), PaymentsModule],
})
export class WebhooksModule {}
