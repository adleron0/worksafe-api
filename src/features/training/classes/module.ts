import { Module } from '@nestjs/common';
import { ClassesController as Controller } from './controller';
import { ClassesService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';
import { CacheModule } from 'src/common/cache';
import { TraineeCertificateModule } from '../trainee_certificate/module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule, CacheModule, TraineeCertificateModule],
})
export class ClassesModule {}
