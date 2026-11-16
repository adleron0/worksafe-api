import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { StockPpeService } from './ppe.service';
import { stockActorOf } from './stock.controller';
import { requireAny } from './stock.rules';

type Json = Record<string, unknown>;
type Q = Record<string, string>;

/** EPI: entregas, devoluções, trocas, ficha por funcionário e pendências. */
@Controller('stock/ppe')
export class StockPpeController {
  constructor(private readonly ppe: StockPpeService) {}

  @Permissions('list_entregas_epi') @Get('employees')
  employees(@Req() req: Request, @Query() q: Q) { return this.ppe.employees(stockActorOf(req), q ?? {}); }
  /** Aba EPI na ficha do funcionário (RH): quem vê entregas ou funcionários. */
  @Get('employees/:id')
  ofEmployee(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const actor = stockActorOf(req);
    requireAny(actor, ['view_entregas_epi', 'view_funcionarios']);
    return this.ppe.ofEmployee(actor, id);
  }
  @Permissions('view_entregas_epi') @Get('employees/:id/sheet')
  sheet(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.ppe.sheet(stockActorOf(req), id); }
  @Permissions('list_entregas_epi') @Get('pending')
  pending(@Req() req: Request) { return this.ppe.pending(stockActorOf(req)); }
  @Permissions('create_entregas_epi') @Post('deliveries')
  deliver(@Req() req: Request, @Body() body: Json) { return this.ppe.deliver(stockActorOf(req), body ?? {}); }
  @Permissions('create_entregas_epi') @Post('returns')
  giveBack(@Req() req: Request, @Body() body: Json) { return this.ppe.giveBack(stockActorOf(req), body ?? {}); }
  @Permissions('create_entregas_epi') @Post('exchanges')
  exchange(@Req() req: Request, @Body() body: Json) { return this.ppe.exchange(stockActorOf(req), body ?? {}); }

  /** A imagem da assinatura de uma movimentação. */
  @Get('signatures/:movementId')
  async signature(@Param('movementId', ParseIntPipe) movementId: number, @Req() req: Request, @Res() res: Response) {
    const actor = stockActorOf(req);
    requireAny(actor, ['view_entregas_epi', 'list_itens_estoque', 'list_locacoes']);
    const body = await this.ppe.signatureImage(actor, movementId);
    res.set({ 'Content-Type': 'image/png', 'Content-Length': String(body.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  }
}
