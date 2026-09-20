import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { UploadModule } from 'src/features/upload/upload.module';
import { StudentCoursesService as Service } from './service';

@Module({ providers: [Service], imports: [PrismaModule, UploadModule], controllers: [], exports: [Service] })
export class StudentCoursesModule {}
