import { Module } from '@nestjs/common';
import { StudentProgressController } from './controller';
import { StudentProgressService } from './service';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';
import { CacheService } from 'src/common/cache/cache.service';

@Module({
  controllers: [StudentProgressController],
  providers: [
    StudentProgressService,
    PrismaService,
    UploadService,
    CacheService,
  ],
  exports: [StudentProgressService],
})
export class StudentProgressModule {}
