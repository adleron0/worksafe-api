import { Module } from '@nestjs/common';
import { StudentCoursesController } from './controller';
import { StudentCoursesService } from './service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { UploadModule } from 'src/features/upload/upload.module';
import { CacheModule } from 'src/common/cache/cache.module';

@Module({
  imports: [PrismaModule, UploadModule, CacheModule],
  controllers: [StudentCoursesController],
  providers: [StudentCoursesService],
  exports: [StudentCoursesService],
})
export class StudentCoursesModule {}
