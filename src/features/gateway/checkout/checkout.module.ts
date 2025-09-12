import { Module, forwardRef } from '@nestjs/common';
import { CheckoutService } from './checkout.service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { AsaasModule } from 'src/common/gateways/asaas/asaas.module';
import { SubscriptionModule } from 'src/features/training/subscription/module';

@Module({
  imports: [
    PrismaModule,
    AsaasModule,
    forwardRef(() => SubscriptionModule),
  ],
  providers: [CheckoutService],
  exports: [CheckoutService],
})
export class CheckoutModule {}
