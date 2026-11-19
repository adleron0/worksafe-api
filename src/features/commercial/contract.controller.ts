import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { getDocumentMulterOptions } from 'src/features/upload/upload.middleware';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { ALL_PROPOSALS_PERMISSION } from './ownership';
import { permissionsOf } from './proposal.controller';
import { ContractActor, ContractService } from './contract.service';
import { MeasurementService } from './measurement.service';
import { WorkMeasurementService } from './work.service';
import { Public } from 'src/auth/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';

const actorOf = (req: Request): ContractActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number; permissions?: unknown } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0), seesAll: permissionsOf(user?.permissions).includes(ALL_PROPOSALS_PERMISSION) };
};
type Json = Record<string, unknown>;

/**
 * Contratos (propostas aceitas). Faturar uma parcela cria a conta a receber:
 * por isso essas rotas pedem a permissão do financeiro, não a do comercial.
 */
@Controller('commercial/contracts')
export class ContractController {
  constructor(private readonly contracts: ContractService, private readonly measurements: MeasurementService, private readonly works: WorkMeasurementService) {}

  @Permissions('list_comercial') @Get()
  list(@Req() req: Request, @Query() query: Record<string, string>) { return this.contracts.list(actorOf(req), query ?? {}); }

  /** Fila "A faturar" do Financeiro: precisa vir antes de `:id`. */
  @Permissions('list_financeiro') @Get('billing')
  billing(@Req() req: Request, @Query() query: Record<string, string>) { return this.contracts.billingQueue(actorOf(req), query ?? {}); }

  @Permissions('list_comercial') @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.contracts.get(actorOf(req), id); }

  @Permissions('list_comercial') @Get(':id/document')
  document(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.contracts.document(actorOf(req), id); }

  @Permissions('update_comercial') @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.contracts.update(actorOf(req), id, body ?? {}); }

  /** Pedido de compra do cliente: número, data e arquivo (PDF ou imagem) no campo `file`. */
  @Permissions('update_comercial') @Put(':id/customer-order')
  @UseInterceptors(FileInterceptor('file', getDocumentMulterOptions('commercial-customer-orders')))
  customerOrder(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json, @UploadedFile() file?: { location?: string; originalname?: string }) {
    return this.contracts.setCustomerOrder(actorOf(req), id, body ?? {}, file);
  }

  @Permissions('update_comercial') @Patch('status/:id')
  status(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.contracts.setStatus(actorOf(req), id, body ?? {}); }

  @Permissions('create_financeiro') @Post(':id/installments/:installmentId/bill')
  bill(@Param('id', ParseIntPipe) id: number, @Param('installmentId', ParseIntPipe) installmentId: number, @Req() req: Request, @Body() body: Json) {
    return this.contracts.bill(actorOf(req), id, installmentId, body ?? {});
  }

  /** Uma nota fiscal para várias parcelas (NF global): cada parcela vira a sua conta a receber. */
  @Permissions('create_financeiro') @Post(':id/installments/bill')
  billMany(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) {
    return this.contracts.billMany(actorOf(req), id, body ?? {});
  }

  /** Alíquotas que o cliente costuma reter na nota (sugestão ao faturar). */
  @Permissions('update_comercial') @Put(':id/retention-rates')
  retentionRates(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) {
    return this.contracts.setRetentionRates(actorOf(req), id, body ?? {});
  }

  @Permissions('inactive_financeiro') @Post(':id/installments/:installmentId/unbill')
  unbill(@Param('id', ParseIntPipe) id: number, @Param('installmentId', ParseIntPipe) installmentId: number, @Req() req: Request) {
    return this.contracts.unbill(actorOf(req), id, installmentId);
  }

  /** Locação: fatura o que está pendente de uma OL do contrato (períodos vencidos, avarias, avulsas) num boletim de medição. */
  @Permissions('create_financeiro') @Post(':id/measurements')
  async billMeasurement(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) {
    const result = await this.measurements.billRental(actorOf(req), id, body ?? {});
    return { ...(await this.contracts.get(actorOf(req), id)), billed: result };
  }

  @Permissions('inactive_financeiro') @Post(':id/measurements/:measurementId/unbill')
  async unbillMeasurement(@Param('id', ParseIntPipe) id: number, @Param('measurementId', ParseIntPipe) measurementId: number, @Req() req: Request) {
    await this.works.unbillAny(actorOf(req), id, measurementId);
    return this.contracts.get(actorOf(req), id);
  }

  // ---------------------------------------------------------------- medição de obra (boletins)

  /** Passa a venda de serviço para medição de obra (frentes, mobilização, caução), enquanto nada foi faturado. */
  @Permissions('update_comercial') @Put(':id/measurement-plan')
  async setPlan(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) {
    await this.works.setPlan(actorOf(req), id, body ?? {});
    return this.contracts.get(actorOf(req), id);
  }

  /** Sugestão do próximo boletim: período e % de cada frente pelo último RDO fechado. */
  @Permissions('list_comercial') @Get(':id/works/suggestion')
  workSuggestion(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Query() query: Record<string, string>) { return this.works.suggestion(actorOf(req), id, query ?? {}); }

  @Permissions('update_comercial') @Post(':id/works')
  async createWork(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) {
    const created = await this.works.create(actorOf(req), id, body ?? {});
    return { ...(await this.contracts.get(actorOf(req), id)), created };
  }

  @Permissions('update_comercial') @Put(':id/works/:mid')
  async updateWork(@Param('id', ParseIntPipe) id: number, @Param('mid', ParseIntPipe) mid: number, @Req() req: Request, @Body() body: Json) {
    await this.works.update(actorOf(req), id, mid, body ?? {});
    return this.contracts.get(actorOf(req), id);
  }

  @Permissions('update_comercial') @Delete(':id/works/:mid')
  async removeWork(@Param('id', ParseIntPipe) id: number, @Param('mid', ParseIntPipe) mid: number, @Req() req: Request) {
    await this.works.remove(actorOf(req), id, mid);
    return this.contracts.get(actorOf(req), id);
  }

  /** Envia ao cliente: gera o link de aprovação. */
  @Permissions('update_comercial') @Post(':id/works/:mid/send')
  async sendWork(@Param('id', ParseIntPipe) id: number, @Param('mid', ParseIntPipe) mid: number, @Req() req: Request) {
    const sent = await this.works.send(actorOf(req), id, mid);
    return { ...(await this.contracts.get(actorOf(req), id)), sent };
  }

  /** Aprovação registrada à mão (o cliente aprovou por outro canal). */
  @Permissions('update_comercial') @Post(':id/works/:mid/approve')
  async approveWork(@Param('id', ParseIntPipe) id: number, @Param('mid', ParseIntPipe) mid: number, @Req() req: Request, @Body() body: Json) {
    await this.works.approve(actorOf(req), id, mid, body ?? {});
    return this.contracts.get(actorOf(req), id);
  }

  /** Boletim com o relatório do período (RDOs): para ver, imprimir ou salvar em PDF. */
  @Permissions('list_comercial') @Get(':id/works/:mid/report')
  workReport(@Param('id', ParseIntPipe) id: number, @Param('mid', ParseIntPipe) mid: number, @Req() req: Request) { return this.works.report(actorOf(req), id, mid); }

  /** Fatura o boletim aprovado: nota → conta a receber (menos a caução), retenções e comissão. */
  @Permissions('create_financeiro') @Post(':id/works/:mid/bill')
  async billWork(@Param('id', ParseIntPipe) id: number, @Param('mid', ParseIntPipe) mid: number, @Req() req: Request, @Body() body: Json) {
    const billed = await this.works.bill(actorOf(req), id, mid, body ?? {});
    return { ...(await this.contracts.get(actorOf(req), id)), billed };
  }

  /** Libera a caução contratual: muda o vencimento da conta da caução. */
  @Permissions('update_financeiro') @Put(':id/deposit')
  async releaseDeposit(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) {
    await this.works.releaseDeposit(actorOf(req), id, body ?? {});
    return this.contracts.get(actorOf(req), id);
  }

  @Permissions('create_classes') @Post(':id/classes/:index')
  createClass(@Param('id', ParseIntPipe) id: number, @Param('index', ParseIntPipe) index: number, @Req() req: Request, @Body() body: Json) {
    return this.contracts.createClass(actorOf(req), id, index, body ?? {});
  }
}

/** Turma fechada × venda: de onde vem o dinheiro da turma (uma venda ou "sem cobrança", com motivo). */
@Controller('commercial/classes')
export class ClassBillingController {
  constructor(private readonly contracts: ContractService) {}

  /** Turmas fechadas sem venda nem "sem cobrança" (aviso do painel). Antes de `:classId`. */
  @Permissions('list_comercial') @Get('unbilled')
  unbilled(@Req() req: Request) { return this.contracts.unbilledClasses(actorOf(req).companyId); }

  @Permissions('list_comercial') @Get(':classId/billing')
  get(@Param('classId', ParseIntPipe) classId: number, @Req() req: Request) { return this.contracts.classBilling(actorOf(req), classId); }

  @Permissions('update_comercial') @Put(':classId/billing')
  set(@Param('classId', ParseIntPipe) classId: number, @Req() req: Request, @Body() body: Json) { return this.contracts.setClassBilling(actorOf(req), classId, body ?? {}); }
}

/** Link do cliente para aprovar ou contestar o boletim de medição (sem login, só pela chave). */
@Controller('commercial/public/measurements')
export class PublicMeasurementController {
  constructor(private readonly works: WorkMeasurementService) {}

  @Public() @Throttle({ default: { limit: 60, ttl: 60000 } }) @Get(':key')
  view(@Param('key') key: string) { return this.works.publicView(key); }

  @Public() @Throttle({ default: { limit: 10, ttl: 60000 } }) @Post(':key/decision')
  decide(@Param('key') key: string, @Req() req: Request, @Body() body: Json) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const ip = (first ? String(first).split(',')[0].trim() : (req.headers['x-real-ip'] as string) || req.ip || '') || null;
    return this.works.decide(key, body ?? {}, { ip: ip ? ip.slice(0, 64) : null, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 400) || null });
  }
}
