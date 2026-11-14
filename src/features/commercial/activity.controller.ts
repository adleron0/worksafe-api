import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { ActivityActor, ActivityService } from './activity.service';

const actorOf = (req: Request): ActivityActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0) };
};
type Json = Record<string, unknown>;

/** Acompanhamento comercial: contatos com o cliente e retornos marcados. */
@Controller('commercial')
export class ActivityController {
  constructor(private readonly activities: ActivityService) {}

  @Permissions('list_comercial') @Get('activities')
  list(@Req() req: Request, @Query() query: Record<string, string>) { return this.activities.list(actorOf(req), query ?? {}); }

  @Permissions('update_comercial') @Post('activities')
  create(@Req() req: Request, @Body() body: Json) { return this.activities.create(actorOf(req), body ?? {}); }

  @Permissions('update_comercial') @Put('activities/:id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.activities.update(actorOf(req), id, body ?? {}); }

  @Permissions('update_comercial') @Patch('activities/:id/done')
  done(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.activities.complete(actorOf(req), id, body ?? {}); }

  @Permissions('update_comercial') @Patch('activities/:id/reopen')
  reopen(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.activities.reopen(actorOf(req), id); }

  @Permissions('update_comercial') @Delete('activities/:id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.activities.remove(actorOf(req), id); }
}
