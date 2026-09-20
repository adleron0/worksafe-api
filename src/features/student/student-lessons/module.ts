import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { UploadModule } from 'src/features/upload/upload.module';
import { StudentLessonsService as Service } from './service';
import { StudentLessonsCustomController } from './custom.controller';

@Module({ providers: [Service], imports: [PrismaModule, UploadModule], controllers: [StudentLessonsCustomController], exports: [Service] })
export class StudentLessonsModule {}
