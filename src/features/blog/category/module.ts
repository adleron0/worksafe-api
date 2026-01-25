import { Module } from '@nestjs/common';
import { CategoryController as Controller } from './controller';
import { CategoryService as Service } from './service';
import { UploadModule } from '../../upload/upload.module';

@Module({
  controllers: [Controller],
  providers: [Service],
  imports: [UploadModule],
})
export class CategoryModule {}
