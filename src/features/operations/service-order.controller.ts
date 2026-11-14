import { Body, Controller, Get, Param, ParseIntPipe, Patch, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { COSTS_PERMISSION, permissionsOf } from 'src/features/commercial/proposal.controller';
import { OrderActor, ServiceOrderService } from './service-order.service';

const actorOf = (req: Request): OrderActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number; permissions?: unknown } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0), canSeeCosts: permissionsOf(user?.permissions).includes(COSTS_PERMISSION) };
};
type Json = Record<string, unknown>;

/** Ordens de serviço: a esteira da operação (mobilizar, agendar, executar, concluir). */
@Controller('service-orders')
export class ServiceOrderController {
  constructor(private readonly orders: ServiceOrderService) {}

  @Permissions('list_ordens_de_servico') @Get()
  list(@Req() req: Request, @Query() query: Record<string, string>) { return this.orders.list(actorOf(req), query ?? {}); }

  @Permissions('list_ordens_de_servico') @Get('options')
  options(@Req() req: Request) { return this.orders.options(actorOf(req)); }

  @Permissions('list_ordens_de_servico') @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.orders.get(actorOf(req), id); }

  @Permissions('update_ordens_de_servico') @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.orders.update(actorOf(req), id, body ?? {}); }

  @Permissions('update_ordens_de_servico') @Patch(':id/status')
  move(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.orders.move(actorOf(req), id, body ?? {}); }
}
