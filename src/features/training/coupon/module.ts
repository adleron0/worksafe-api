import { Module } from '@nestjs/common';
import { CouponController as Controller } from './controller';
import { CouponService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class CouponModule {}
