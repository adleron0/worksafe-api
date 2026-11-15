import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { COSTS_PERMISSION, permissionsOf } from 'src/features/commercial/proposal.controller';
import { DailyReportService } from './daily-report.service';
import { OrderResultService } from './order-result.service';
import { ALL_ORDERS_PERMISSION, OrderActor, ServiceOrderService } from './service-order.service';

const actorOf = (req: Request): OrderActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number; permissions?: unknown } }).user;
  const permissions = permissionsOf(user?.permissions);
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0), canSeeCosts: permissions.includes(COSTS_PERMISSION), seesAll: permissions.includes(ALL_ORDERS_PERMISSION) };
};
type Json = Record<string, unknown>;

/** Ordens de serviço: a esteira da operação (mobilizar, agendar, executar, concluir). */
@Controller('service-orders')
export class ServiceOrderController {
  constructor(private readonly orders: ServiceOrderService, private readonly resultService: OrderResultService) {}

  @Permissions('list_ordens_de_servico') @Get()
  list(@Req() req: Request, @Query() query: Record<string, string>) { return this.orders.list(actorOf(req), query ?? {}); }

  @Permissions('list_ordens_de_servico') @Get('options')
  options(@Req() req: Request) { return this.orders.options(actorOf(req)); }

  /** Resultado de todas as obras (orçado × realizado × projeção): só com a permissão de custos. */
  @Permissions('list_ordens_de_servico') @Get('results')
  results(@Req() req: Request, @Query() query: Record<string, string>) { return this.resultService.list(actorOf(req), query ?? {}); }

  @Permissions('list_ordens_de_servico') @Get(':id/result')
  result(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.resultService.of(actorOf(req), id); }

  @Permissions('list_ordens_de_servico') @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.orders.get(actorOf(req), id); }

  @Permissions('update_ordens_de_servico') @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.orders.update(actorOf(req), id, body ?? {}); }

  @Permissions('update_ordens_de_servico') @Patch(':id/status')
  move(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.orders.move(actorOf(req), id, body ?? {}); }
}

/**
 * RDO — relatório diário de obra. Quem vê as ordens de serviço vê os RDOs das
 * que enxerga; lançar e fechar RDO pede a permissão própria (`update_rdo`), para
 * o encarregado preencher o diário sem poder alterar a OS.
 */
@Controller()
export class DailyReportController {
  constructor(private readonly reports: DailyReportService) {}

  @Permissions('list_ordens_de_servico') @Get('service-reports')
  recent(@Req() req: Request, @Query() query: Record<string, string>) { return this.reports.recent(actorOf(req), query ?? {}); }

  @Permissions('list_ordens_de_servico') @Get('service-orders/:orderId/reports')
  list(@Param('orderId', ParseIntPipe) orderId: number, @Req() req: Request) { return this.reports.list(actorOf(req), orderId); }

  @Permissions('list_ordens_de_servico') @Get('service-orders/:orderId/reports/template')
  template(@Param('orderId', ParseIntPipe) orderId: number, @Req() req: Request, @Query() query: Record<string, string>) { return this.reports.template(actorOf(req), orderId, query ?? {}); }

  @Permissions('update_rdo') @Post('service-orders/:orderId/reports')
  create(@Param('orderId', ParseIntPipe) orderId: number, @Req() req: Request, @Body() body: Json) { return this.reports.create(actorOf(req), orderId, body ?? {}); }

  @Permissions('list_ordens_de_servico') @Get('service-reports/:id')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reports.get(actorOf(req), id); }

  @Permissions('update_rdo') @Put('service-reports/:id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.reports.update(actorOf(req), id, body ?? {}); }

  @Permissions('update_rdo') @Patch('service-reports/:id/close')
  close(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reports.close(actorOf(req), id); }

  @Permissions('update_rdo') @Patch('service-reports/:id/reopen')
  reopen(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.reports.reopen(actorOf(req), id, body ?? {}); }

  @Permissions('update_rdo') @Delete('service-reports/:id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reports.remove(actorOf(req), id); }
}
