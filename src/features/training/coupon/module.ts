import { Module } from '@nestjs/common';
import { CouponValidateController } from './validate.controller';
import { CouponService as Service } from './service';

/** CRUD do cupom vive no CrudModule; aqui ficam a validação pública e o service usado pelo checkout. */
@Module({
  controllers: [CouponValidateController],
  providers: [Service],
  exports: [Service],
})
export class CouponModule {}
