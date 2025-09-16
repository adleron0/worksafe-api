import { Module, forwardRef } from '@nestjs/common';
import { CheckoutService } from './checkout.service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { AsaasModule } from 'src/common/gateways/asaas/asaas.module';
import { SubscriptionModule } from 'src/features/training/subscription/module';
import { SplitTransactionModule } from 'src/features/splitTransaction/split-transaction.module';

@Module({
  imports: [
    PrismaModule,
    AsaasModule,
    forwardRef(() => SubscriptionModule),
    SplitTransactionModule,
  ],
  providers: [CheckoutService],
  exports: [CheckoutService],
})
export class CheckoutModule {}
