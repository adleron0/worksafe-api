import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UploadedFile,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
  Query,
  applyDecorators,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { StudentAuth } from 'src/auth/decorators/student-auth.decorator';
// Import entity template
import { StudentService as Service } from './service';
// Import utils specifics
import { FileInterceptor } from '@nestjs/platform-express';
import { getMulterOptions } from '../../upload/upload.middleware';
// Import generic controller
import { Public } from 'src/auth/decorators/public.decorator';
// Import cache
import { Cache, CacheEvictAll } from 'src/common/cache';
import { CacheService } from 'src/common/cache/cache.service';
// Import de configuraões

function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: 'Trainee' as keyof PrismaClient,
  name: 'Student',
  route: 'student',
  permission: 'student',
};

@Controller('student')
export class StudentCustomController {
  constructor(
    private readonly Service: Service,
    // cacheService é usado pelos decorators de cache
    private readonly cacheService: CacheService,
  ) {
  }

}