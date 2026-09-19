import { CrudService } from '@adleron/crud-core';
import { Controller, Param, Patch, Req } from '@nestjs/common';
import { Request } from 'express';

import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { defineWorksafeEntity } from 'src/common/crud/crud.module';
import { blogVisitorEntity } from './rules.crud';

const def = defineWorksafeEntity(blogVisitorEntity);

/** Bloqueio de visitante — via CrudService (escopo + auditoria; o antigo era update por id sem companyId). */
@Controller('blog/visitors')
export class VisitorCustomController {
  constructor(private readonly crud: CrudService<Request>) {}

  @Permissions('inactive_blog') @Patch('block/:id')
  block(@Param('id') id: string, @Req() request: Request) {
    return this.crud.update(def, id, { blocked: true }, request);
  }

  @Permissions('activate_blog') @Patch('unblock/:id')
  unblock(@Param('id') id: string, @Req() request: Request) {
    return this.crud.update(def, id, { blocked: false, blockedReason: null }, request);
  }
}
