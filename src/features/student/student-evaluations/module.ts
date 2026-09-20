import { Module } from '@nestjs/common';
import { UploadModule } from 'src/features/upload/upload.module';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';
import { CacheService } from 'src/common/cache/cache.service';
import { StudentEvaluationsService as Service } from './service';
import { StudentEvaluationsCustomController } from './custom.controller';

@Module({ providers: [Service], imports: [UploadModule], controllers: [StudentEvaluationsCustomController], exports: [Service] })
export class StudentEvaluationsModule {}
