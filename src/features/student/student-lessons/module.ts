import { Module } from '@nestjs/common';
import { StudentLessonsController } from './controller';
import { StudentLessonsService } from './service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { UploadModule } from 'src/features/upload/upload.module';
import { CacheModule } from 'src/common/cache/cache.module';

@Module({
  imports: [PrismaModule, UploadModule, CacheModule],
  controllers: [StudentLessonsController],
  providers: [StudentLessonsService],
  exports: [StudentLessonsService],
})
export class StudentLessonsModule {}
