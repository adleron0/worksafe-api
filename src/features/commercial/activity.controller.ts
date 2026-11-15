import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { ActivityActor, ActivityService } from './activity.service';
import { ALL_PROPOSALS_PERMISSION } from './ownership';
import { permissionsOf } from './proposal.controller';

const actorOf = (req: Request): ActivityActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number; permissions?: unknown } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0), seesAll: permissionsOf(user?.permissions).includes(ALL_PROPOSALS_PERMISSION) };
};
type Json = Record<string, unknown>;

/**
 * Acompanhamento comercial: contatos com o cliente e retornos marcados.
 * Registrar e agendar pede a permissão própria (`update_acompanhamento`), para
 * quem acompanha o cliente não precisar poder editar a proposta.
 */
@Controller('commercial')
export class ActivityController {
  constructor(private readonly activities: ActivityService) {}

  @Permissions('list_comercial') @Get('activities')
  list(@Req() req: Request, @Query() query: Record<string, string>) { return this.activities.list(actorOf(req), query ?? {}); }

  @Permissions('update_acompanhamento') @Post('activities')
  create(@Req() req: Request, @Body() body: Json) { return this.activities.create(actorOf(req), body ?? {}); }

  @Permissions('update_acompanhamento') @Put('activities/:id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.activities.update(actorOf(req), id, body ?? {}); }

  @Permissions('update_acompanhamento') @Patch('activities/:id/done')
  done(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.activities.complete(actorOf(req), id, body ?? {}); }

  @Permissions('update_acompanhamento') @Patch('activities/:id/reopen')
  reopen(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.activities.reopen(actorOf(req), id); }

  @Permissions('update_acompanhamento') @Delete('activities/:id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.activities.remove(actorOf(req), id); }
}
