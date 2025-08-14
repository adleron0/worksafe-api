import { Module } from '@nestjs/common';
import { ClassesController as Controller } from './controller';
import { ClassesService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';
import { CacheModule } from 'src/common/cache';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule, CacheModule],
})
export class ClassesModule {}
