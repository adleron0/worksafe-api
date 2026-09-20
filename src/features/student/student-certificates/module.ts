import { Module } from '@nestjs/common';
import { UploadModule } from 'src/features/upload/upload.module';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';
import { CacheService } from 'src/common/cache/cache.service';
import { StudentCertificatesService as Service } from './service';

@Module({ providers: [Service], imports: [UploadModule], controllers: [], exports: [Service] })
export class StudentCertificatesModule {}
