import { Module } from '@nestjs/common';
import { UserController } from './controller';
import { UserService } from './service';
import { UploadModule } from '../../upload/upload.module';
import { PaymentsModule } from 'src/payments/payments.module';

@Module({
  imports: [UploadModule, PaymentsModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
