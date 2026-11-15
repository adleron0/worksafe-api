import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { ActivityActor, EmployeeActivityService } from './activity.service';

const actorOf = (req: Request): ActivityActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0) };
};
type Json = Record<string, unknown>;

/** Atividades fora de OS (RH): ver pede o mapa de alocação; lançar e alterar pede a permissão própria. */
@Controller('hr-activities')
export class EmployeeActivityController {
  constructor(private readonly activities: EmployeeActivityService) {}

  @Permissions('view_alocacao') @Get('types')
  types(@Req() req: Request) { return this.activities.types(actorOf(req)); }

  @Permissions('update_alocacao') @Post('types')
  createType(@Req() req: Request, @Body() body: Json) { return this.activities.createType(actorOf(req), body ?? {}); }

  @Permissions('update_alocacao') @Put('types/:id')
  updateType(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.activities.updateType(actorOf(req), id, body ?? {}); }

  @Permissions('update_alocacao') @Patch('types/:id/inactive')
  inactivateType(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.activities.inactivateType(actorOf(req), id); }

  @Permissions('view_alocacao') @Get()
  list(@Req() req: Request, @Query() query: Record<string, string>) { return this.activities.list(actorOf(req), query ?? {}); }

  @Permissions('view_alocacao') @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.activities.get(actorOf(req), id); }

  @Permissions('update_alocacao') @Post()
  create(@Req() req: Request, @Body() body: Json) { return this.activities.create(actorOf(req), body ?? {}); }

  @Permissions('update_alocacao') @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.activities.update(actorOf(req), id, body ?? {}); }

  @Permissions('update_alocacao') @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.activities.remove(actorOf(req), id); }
}
