import { Module } from '@nestjs/common';
import { PaymentsModule } from 'src/payments/payments.module';
import { CouponValidateController } from './validate.controller';
import { CouponService as Service } from './service';

/** CRUD do cupom vive no CrudModule; aqui a validação pública e o service usado pelo checkout. */
@Module({
  controllers: [CouponValidateController],
  providers: [Service],
  imports: [PaymentsModule],
  exports: [Service],
})
export class CouponModule {}
