import { Module } from '@nestjs/common';
import { StudentLessonsController } from './controller';
import { StudentLessonsService } from './service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { UploadModule } from 'src/features/upload/upload.module';

@Module({
  imports: [PrismaModule, UploadModule],
  controllers: [StudentLessonsController],
  providers: [StudentLessonsService],
  exports: [StudentLessonsService],
})
export class StudentLessonsModule {}
