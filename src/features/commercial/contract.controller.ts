import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { getDocumentMulterOptions } from 'src/features/upload/upload.middleware';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { ALL_PROPOSALS_PERMISSION } from './ownership';
import { permissionsOf } from './proposal.controller';
import { ContractActor, ContractService } from './contract.service';
import { MeasurementService } from './measurement.service';

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
  constructor(private readonly contracts: ContractService, private readonly measurements: MeasurementService) {}

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
    await this.measurements.unbill(actorOf(req), id, measurementId);
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
