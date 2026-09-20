import { CrudService } from '@adleron/crud-core';
import { Body, Controller, HttpCode, Post, Req, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { compositeUpsert } from 'src/common/crud/composite-upsert';
import { defineWorksafeEntity } from 'src/common/crud/crud.module';
import { onlineModelLessonEntity } from './rules.crud';

const def = defineWorksafeEntity(onlineModelLessonEntity);

/** Lição×modelo: upsert por (modelId, lessonId). */
@Controller('online-course-lesson')
export class OnlineModelLessonCustomController {
  constructor(private readonly crud: CrudService<Request>) {}
  @Permissions('create_treinamentos') @Post('upsert') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file'))
  upsert(@Body() body: Record<string, unknown>, @Req() request: Request) {
    return compositeUpsert(this.crud, def, ['modelId', 'lessonId'], body, request);
  }
}
