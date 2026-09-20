import { Module, forwardRef } from '@nestjs/common';
import { UploadModule } from 'src/features/upload/upload.module';
import { CheckoutModule } from 'src/features/gateway/checkout/checkout.module';
import { AlunosModule } from '../trainees/module';
import { CouponModule } from '../coupon/module';
import { SubscriptionService as Service } from './service';

/** CRUD vive no CrudModule; aqui o service (subscribe público + checkout). */
@Module({ providers: [Service], imports: [UploadModule, forwardRef(() => CheckoutModule), AlunosModule, CouponModule], exports: [Service] })
export class SubscriptionModule {}
