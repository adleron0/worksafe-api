import { Module } from '@nestjs/common';
import { StudentCertificatesController } from './controller';
import { StudentCertificatesService } from './service';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';
import { CacheService } from 'src/common/cache/cache.service';

@Module({
  controllers: [StudentCertificatesController],
  providers: [
    StudentCertificatesService,
    PrismaService,
    UploadService,
    CacheService,
  ],
  exports: [StudentCertificatesService],
})
export class StudentCertificatesModule {}
