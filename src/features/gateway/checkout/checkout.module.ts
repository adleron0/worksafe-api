import { Module, forwardRef } from '@nestjs/common';
import { CheckoutService } from './checkout.service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { PaymentsModule } from 'src/payments/payments.module';
import { SubscriptionModule } from 'src/features/training/subscription/module';

@Module({
  // O checkout não conhece mais nenhum gateway concreto: fala com o
  // GatewayResolver exportado pelo PaymentsModule.
  imports: [PrismaModule, PaymentsModule, forwardRef(() => SubscriptionModule)],
  providers: [CheckoutService],
  exports: [CheckoutService],
})
export class CheckoutModule {}
