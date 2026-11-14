import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { getDocumentMulterOptions } from 'src/features/upload/upload.middleware';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { ContractActor, ContractService } from './contract.service';

const actorOf = (req: Request): ContractActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0) };
};
type Json = Record<string, unknown>;

/**
 * Contratos (propostas aceitas). Faturar uma parcela cria a conta a receber:
 * por isso essas rotas pedem a permissão do financeiro, não a do comercial.
 */
@Controller('commercial/contracts')
export class ContractController {
  constructor(private readonly contracts: ContractService) {}

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

  @Permissions('create_classes') @Post(':id/classes/:index')
  createClass(@Param('id', ParseIntPipe) id: number, @Param('index', ParseIntPipe) index: number, @Req() req: Request, @Body() body: Json) {
    return this.contracts.createClass(actorOf(req), id, index, body ?? {});
  }
}
