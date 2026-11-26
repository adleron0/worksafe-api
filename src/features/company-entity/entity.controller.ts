import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { CompanyEntityService, EntityActor } from './entity.service';

type Json = Record<string, unknown>;
const actorOf = (req: Request): EntityActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0) };
};

/** Empresas do grupo (CNPJs). A lista é de todos os usuários: as telas mostram o campo "Empresa". */
@Controller('company-entities')
export class CompanyEntityController {
  constructor(private readonly entities: CompanyEntityService) {}

  @Get()
  list(@Req() req: Request, @Query('all') all?: string) { return this.entities.list(actorOf(req).companyId, all === '1' || all === 'true'); }

  @Get(':id')
  async get(@Req() req: Request, @Param('id', ParseIntPipe) id: number) { return this.entities.out(await this.entities.get(actorOf(req).companyId, id)); }

  @Permissions('config_empresas_grupo') @Get(':id/usage')
  usage(@Req() req: Request, @Param('id', ParseIntPipe) id: number) { return this.entities.usage(actorOf(req).companyId, id); }

  @Permissions('config_empresas_grupo') @Post()
  create(@Req() req: Request, @Body() body: Json) { return this.entities.create(actorOf(req), body ?? {}); }

  @Permissions('config_empresas_grupo') @Put(':id')
  update(@Req() req: Request, @Param('id', ParseIntPipe) id: number, @Body() body: Json) { return this.entities.update(actorOf(req), id, body ?? {}); }

  @Permissions('config_empresas_grupo') @Post(':id/assign') @HttpCode(200)
  assign(@Req() req: Request, @Param('id', ParseIntPipe) id: number, @Body() body: Json) { return this.entities.assign(actorOf(req), id, body ?? {}); }
}
