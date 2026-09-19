import { CrudService } from '@adleron/crud-core';
import { Body, Controller, Param, Put, Req, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';

import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { defineWorksafeEntity } from 'src/common/crud/crud.module';
import { getMulterOptions } from 'src/features/upload/upload.middleware';
import { instructorEntity } from './rules.crud';

const def = defineWorksafeEntity(instructorEntity);

/**
 * Rota custom fora da fábrica: assinatura do instrutor. Reusa o update do
 * CrudService (escopo, permissão, auditoria) — o hook fileUpload grava
 * `signatureUrl` a partir do campo `signature` do multipart.
 */
@Controller('instructors')
export class InstructorSignatureController {
  constructor(private readonly crud: CrudService<Request>) {}

  @Permissions('update_instrutores')
  @Put(':id/signature')
  @UseInterceptors(FileInterceptor('signature', getMulterOptions('instructor-signature')))
  signature(@Param('id') id: string, @Req() request: Request, @Body() body: unknown) {
    return this.crud.update(def, id, body ?? {}, request);
  }
}
