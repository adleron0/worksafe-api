import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { COSTS_PERMISSION, permissionsOf } from 'src/features/commercial/proposal.controller';
import { getDocumentMulterOptions } from 'src/features/upload/upload.middleware';
import { PurchaseActor, PurchaseOrderService } from './purchase-order.service';

export const APPROVE_PURCHASE_PERMISSION = 'approve_pedidos_de_compra';

const actorOf = (req: Request): PurchaseActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number; permissions?: unknown } }).user;
  const permissions = permissionsOf(user?.permissions);
  return {
    userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0),
    canApprove: permissions.includes(APPROVE_PURCHASE_PERMISSION), canSeeCosts: permissions.includes(COSTS_PERMISSION),
  };
};
type Json = Record<string, unknown>;

/** Pedidos de compra: a esteira de Suprimentos (solicitar, aprovar, comprar, receber). */
@Controller('purchase-orders')
export class PurchaseOrderController {
  constructor(private readonly purchases: PurchaseOrderService) {}

  @Permissions('list_pedidos_de_compra') @Get()
  list(@Req() req: Request, @Query() query: Record<string, string>) { return this.purchases.list(actorOf(req), query ?? {}); }

  @Permissions('list_pedidos_de_compra') @Get('options')
  options(@Req() req: Request) { return this.purchases.options(actorOf(req)); }

  /** O comprometido de uma obra: quem vê a OS vê as compras dela. */
  @Permissions('list_ordens_de_servico') @Get('service-order/:orderId')
  ofServiceOrder(@Param('orderId', ParseIntPipe) orderId: number, @Req() req: Request) { return this.purchases.ofServiceOrder(actorOf(req), orderId); }

  @Permissions('create_pedidos_de_compra') @Post('suppliers')
  createSupplier(@Req() req: Request, @Body() body: Json) { return this.purchases.createSupplier(actorOf(req), body ?? {}); }

  @Permissions('list_pedidos_de_compra') @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.purchases.get(actorOf(req), id); }

  @Permissions('create_pedidos_de_compra') @Post()
  create(@Req() req: Request, @Body() body: Json) { return this.purchases.create(actorOf(req), body ?? {}); }

  @Permissions('update_pedidos_de_compra') @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.purchases.update(actorOf(req), id, body ?? {}); }

  /** A permissão de aprovar é conferida no serviço, só nas passagens de aprovar e recusar. */
  @Permissions('update_pedidos_de_compra') @Patch(':id/status')
  move(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.purchases.move(actorOf(req), id, body ?? {}); }

  @Permissions('update_pedidos_de_compra') @Post(':id/attachments')
  @UseInterceptors(FileInterceptor('file', getDocumentMulterOptions('purchase-orders')))
  attach(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json, @UploadedFile() file?: Express.MulterS3.File) {
    return this.purchases.addAttachment(actorOf(req), id, file, body?.kind);
  }

  @Permissions('update_pedidos_de_compra') @Delete(':id/attachments/:attachmentId')
  detach(@Param('id', ParseIntPipe) id: number, @Param('attachmentId') attachmentId: string, @Req() req: Request) {
    return this.purchases.removeAttachment(actorOf(req), id, attachmentId);
  }
}
