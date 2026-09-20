import { CrudService } from '@adleron/crud-core';
import { Body, Controller, HttpCode, Post, Req, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { compositeUpsert } from 'src/common/crud/composite-upsert';
import { defineWorksafeEntity } from 'src/common/crud/crud.module';
import { attendanceEntity } from './rules.crud';

const def = defineWorksafeEntity(attendanceEntity);

/** Presença por (classId, traineeId, day) — sem unique no schema, upsert composto. */
@Controller('attendance-list')
export class AttendanceCustomController {
  constructor(private readonly crud: CrudService<Request>) {}
  @Permissions('create_classes') @Post('upsert') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file'))
  upsert(@Body() body: Record<string, unknown>, @Req() request: Request) {
    return compositeUpsert(this.crud, def, ['classId', 'traineeId', 'day'], body, request);
  }
}
