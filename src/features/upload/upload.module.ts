import { Module } from '@nestjs/common';
import { UploadService } from './upload.service';
import { UploadOptimizationService } from './upload-optimization.service';
import { ImageOptimizationInterceptor } from './image-optimization.interceptor';

@Module({
  providers: [
    UploadService,
    UploadOptimizationService,
    ImageOptimizationInterceptor,
  ],
  exports: [
    UploadService,
    UploadOptimizationService,
    ImageOptimizationInterceptor,
  ],
})
export class UploadModule {}
