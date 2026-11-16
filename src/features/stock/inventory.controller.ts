import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Public } from 'src/auth/decorators/public.decorator';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { StockInventoryService } from './inventory.service';
import { stockActorOf } from './stock.controller';

type Json = Record<string, unknown>;
type Q = Record<string, string>;

/** Inventário, relatórios e loja do site. */
@Controller('stock')
export class StockInventoryController {
  constructor(private readonly inventory: StockInventoryService) {}

  @Permissions('view_ajuste_estoque') @Get('counts')
  counts(@Req() req: Request) { return this.inventory.counts(stockActorOf(req)); }
  @Permissions('view_ajuste_estoque') @Get('counts/:id')
  count(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.inventory.get(stockActorOf(req), id); }
  @Permissions('ajuste_estoque') @Post('counts')
  open(@Req() req: Request, @Body() body: Json) { return this.inventory.open(stockActorOf(req), body ?? {}); }
  @Permissions('ajuste_estoque') @Put('counts/:id')
  record(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.inventory.record(stockActorOf(req), id, body ?? {}); }
  @Permissions('ajuste_estoque') @Post('counts/:id/close') @HttpCode(200)
  close(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.inventory.close(stockActorOf(req), id, body ?? {}); }

  @Permissions('list_itens_estoque') @Get('reports')
  report(@Req() req: Request, @Query() q: Q) { return this.inventory.report(stockActorOf(req), q ?? {}); }

  /** Público (site): pronta entrega ou sob encomenda, por produto ligado. */
  @Public() @Get('public/availability')
  availability() { return this.inventory.availability(); }
  @Permissions('list_itens_estoque') @Get('site-products')
  products(@Req() req: Request) { return this.inventory.products(stockActorOf(req)); }
  @Permissions('update_itens_estoque', 'create_loja_site') @Post('items/:id/publish')
  publish(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.inventory.publish(stockActorOf(req), id, body ?? {}); }
}
