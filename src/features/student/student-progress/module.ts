import { Module } from '@nestjs/common';
import { UploadModule } from 'src/features/upload/upload.module';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';
import { CacheService } from 'src/common/cache/cache.service';
import { StudentProgressService as Service } from './service';
import { StudentProgressCustomController } from './custom.controller';

@Module({ providers: [Service], imports: [UploadModule], controllers: [StudentProgressCustomController], exports: [Service] })
export class StudentProgressModule {}
