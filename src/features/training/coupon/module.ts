import { Module } from '@nestjs/common';
import { CouponController as Controller } from './controller';
import { CouponService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
  exports: [Service], // Exporta o service para ser usado em outros módulos
})
export class CouponModule {}
