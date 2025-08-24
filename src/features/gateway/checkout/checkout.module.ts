import { Module } from '@nestjs/common';
import { CheckoutService } from './checkout.service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { AsaasModule } from 'src/common/gateways/asaas/asaas.module';
import { CacheModule } from 'src/common/cache/cache.module';

@Module({
  imports: [
    PrismaModule,
    AsaasModule,
    CacheModule,
  ],
  providers: [CheckoutService],
  exports: [CheckoutService],
})
export class CheckoutModule {}
