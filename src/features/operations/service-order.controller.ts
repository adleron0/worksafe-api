import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { COSTS_PERMISSION, permissionsOf } from 'src/features/commercial/proposal.controller';
import { DOCUMENTS_VIEW_PERMISSION, EmployeeDocumentService } from 'src/features/hr/document.service';
import { PERSONAL_PERMISSION } from 'src/features/hr/employee.service';
import { Throttle } from '@nestjs/throttler';
import { Public } from 'src/auth/decorators/public.decorator';
import { DailyReportService } from './daily-report.service';
import { OrderDocumentService, VALUES_PERMISSION } from './order-document.service';
import { OrderResultService } from './order-result.service';
import { ALL_ORDERS_PERMISSION, OrderActor, ServiceOrderService } from './service-order.service';

const actorOf = (req: Request): OrderActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number; permissions?: unknown } }).user;
  const permissions = permissionsOf(user?.permissions);
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0), canSeeCosts: permissions.includes(COSTS_PERMISSION), seesAll: permissions.includes(ALL_ORDERS_PERMISSION), canSeeValues: permissions.includes(VALUES_PERMISSION) };
};
type Json = Record<string, unknown>;

/** Ordens de serviço: a esteira da operação (mobilizar, agendar, executar, concluir). */
@Controller('service-orders')
export class ServiceOrderController {
  constructor(private readonly orders: ServiceOrderService, private readonly resultService: OrderResultService, private readonly documents: EmployeeDocumentService, private readonly sheets: OrderDocumentService) {}

  @Permissions('list_ordens_de_servico') @Get()
  list(@Req() req: Request, @Query() query: Record<string, string>) { return this.orders.list(actorOf(req), query ?? {}); }

  /** Funcionários para escalar na obra. Só nomes, funções e disponibilidade: quem vê a OS pode montar a equipe sem permissão de RH. */
  @Permissions('list_ordens_de_servico') @Get(':id/team-options')
  teamOptions(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Query() query: Record<string, string>) {
    const user = (req as Request & { user?: { permissions?: unknown } }).user;
    return this.orders.teamOptions(actorOf(req), id, query ?? {}, permissionsOf(user?.permissions).includes('view_ocorrencias_funcionarios'));
  }

  /** Documentos da equipe da obra (para a integração no cliente): pede ver a OS e ver documentos de funcionários. */
  @Permissions('list_ordens_de_servico') @Get(':id/team-documents')
  async teamDocuments(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    this.assertDocuments(req);
    const team = await this.orders.linkedTeam(actorOf(req), id);
    const matrix = await this.documents.teamMatrix(actorOf(req).companyId, team.employeeIds, team.until);
    return { ...matrix, rows: matrix.rows.map((row) => ({ ...row, role: team.role.get(row.id) || row.role })), outside: team.outside };
  }

  /** O pacote de documentos da equipe, num ZIP com uma pasta por pessoa e a folha de rosto. */
  @Permissions('list_ordens_de_servico') @Post(':id/team-documents/package') @HttpCode(200)
  async teamPackage(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json, @Res() res: Response) {
    const permissions = this.assertDocuments(req);
    const actor = actorOf(req);
    const team = await this.orders.linkedTeam(actor, id);
    const typeIds = Array.isArray(body?.typeIds) ? [...new Set((body.typeIds as unknown[]).map(Number).filter((item) => item > 0))] : [];
    const only = Array.isArray(body?.employeeIds) ? (body.employeeIds as unknown[]).map(Number) : null;
    const result = await this.documents.teamPackage({ userId: actor.userId, companyId: actor.companyId }, {
      title: `Documentos ${team.number}${team.customer ? ` - ${team.customer}` : ''}`, employeeIds: only ? team.employeeIds.filter((item) => only.includes(item)) : team.employeeIds, typeIds,
      until: team.until, role: team.role, seesPersonal: permissions.includes(PERSONAL_PERMISSION), entity: 'hr_package', entityId: id,
    });
    res.set({
      'Content-Type': 'application/zip', 'Content-Length': String(result.body.length), 'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename*=UTF-8\'\'${encodeURIComponent(result.fileName)}`, 'Access-Control-Expose-Headers': 'Content-Disposition',
    });
    res.end(result.body);
  }

  private assertDocuments(req: Request): string[] {
    const user = (req as Request & { user?: { permissions?: unknown } }).user;
    const permissions = permissionsOf(user?.permissions);
    if (!permissions.includes(DOCUMENTS_VIEW_PERMISSION)) throw new ForbiddenException('Você não tem permissão para ver documentos de funcionários');
    return permissions;
  }

  @Permissions('list_ordens_de_servico') @Get('options')
  options(@Req() req: Request) { return this.orders.options(actorOf(req)); }

  /** Resultado de todas as obras (orçado × realizado × projeção): só com a permissão de custos. */
  @Permissions('list_ordens_de_servico') @Get('results')
  results(@Req() req: Request, @Query() query: Record<string, string>) { return this.resultService.list(actorOf(req), query ?? {}); }

  @Permissions('list_ordens_de_servico') @Get(':id/result')
  result(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.resultService.of(actorOf(req), id); }

  /** A folha da OS (a mesma da tela e da impressão). `?values=1` pede os valores da venda (com a permissão). */
  @Permissions('list_ordens_de_servico') @Get(':id/document')
  document(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Query() query: Record<string, string>) { return this.sheets.document(actorOf(req), id, query ?? {}); }

  /** Cronograma × RDO: dias da obra, curva previsto × feito, etapas e projeção de término. */
  @Permissions('list_ordens_de_servico') @Get(':id/timeline')
  timeline(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.sheets.timeline(actorOf(req), id); }

  /** Link do cliente: ver, ligar/desligar e escolher o que mostra, trocar a chave. */
  @Permissions('list_ordens_de_servico') @Get(':id/public')
  publicSettings(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.sheets.publicSettings(actorOf(req), id); }

  @Permissions('update_ordens_de_servico') @Put(':id/public')
  updatePublic(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.sheets.updatePublic(actorOf(req), id, body ?? {}); }

  @Permissions('update_ordens_de_servico') @Post(':id/public/renew') @HttpCode(200)
  renewPublic(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.sheets.renewPublic(actorOf(req), id); }

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

  /** Estatísticas do diário num período (de todas as obras que a pessoa vê, ou de uma). */
  @Permissions('list_ordens_de_servico') @Get('service-reports/stats')
  stats(@Req() req: Request, @Query() query: Record<string, string>) { return this.reports.stats(actorOf(req), query ?? {}); }

  @Permissions('list_ordens_de_servico') @Get('service-reports/:id')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reports.get(actorOf(req), id); }

  @Permissions('update_rdo') @Put('service-reports/:id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.reports.update(actorOf(req), id, body ?? {}); }

  @Permissions('update_rdo') @Patch('service-reports/:id/close')
  close(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reports.close(actorOf(req), id); }

  @Permissions('update_rdo') @Patch('service-reports/:id/reopen')
  reopen(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.reports.reopen(actorOf(req), id, body ?? {}); }

  /** Devolver para quem preencheu corrigir é do coordenador (quem altera a OS), não do encarregado. */
  @Permissions('update_ordens_de_servico') @Patch('service-reports/:id/return')
  sendBack(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.reports.sendBack(actorOf(req), id, body ?? {}); }

  @Permissions('list_ordens_de_servico') @Get('service-reports/:id/findings')
  findings(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reports.findings(actorOf(req), id); }

  @Permissions('update_rdo') @Delete('service-reports/:id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reports.remove(actorOf(req), id); }
}

/** Acompanhamento da obra pelo cliente: link aberto, só leitura, sem valores. */
@Controller('public/service-orders')
export class PublicServiceOrderController {
  constructor(private readonly sheets: OrderDocumentService) {}

  @Public() @Throttle({ default: { limit: 60, ttl: 60000 } }) @Get(':key')
  view(@Param('key') key: string) { return this.sheets.publicView(String(key ?? '')); }
}
