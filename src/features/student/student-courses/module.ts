import { Module } from '@nestjs/common';
import { StudentCoursesController } from './controller';
import { StudentCoursesService } from './service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { UploadModule } from 'src/features/upload/upload.module';

@Module({
  imports: [PrismaModule, UploadModule],
  controllers: [StudentCoursesController],
  providers: [StudentCoursesService],
  exports: [StudentCoursesService],
})
export class StudentCoursesModule {}
