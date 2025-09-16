import { Module, forwardRef } from '@nestjs/common';
import { SubscriptionController as Controller } from './controller';
import { SubscriptionService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';
import { CheckoutModule } from 'src/features/gateway/checkout/checkout.module';
import { AlunosModule } from '../trainees/module';
import { CouponModule } from '../coupon/module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [
    UploadModule,
    forwardRef(() => CheckoutModule),
    AlunosModule,
    CouponModule, // Importa o módulo de cupons
  ],
  exports: [Service], // Exporta o service para outros módulos poderem usar
})
export class SubscriptionModule {}
