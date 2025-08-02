import { Module } from '@nestjs/common';
import { UserController } from './controller';
import { UserService } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  imports: [UploadModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
