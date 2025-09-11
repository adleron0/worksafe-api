import { Module } from '@nestjs/common';
import { StudentEvaluationsController } from './controller';
import { StudentEvaluationsService } from './service';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';
import { CacheService } from 'src/common/cache/cache.service';

@Module({
  controllers: [StudentEvaluationsController],
  providers: [
    StudentEvaluationsService,
    PrismaService,
    UploadService,
    CacheService,
  ],
  exports: [StudentEvaluationsService],
})
export class StudentEvaluationsModule {}
