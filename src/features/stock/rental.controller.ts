import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { StockRentalService } from './rental.service';
import { stockActorOf } from './stock.controller';

type Json = Record<string, unknown>;
type Q = Record<string, string>;

/** Locação de equipamento próprio a clientes. */
@Controller('stock/rentals')
export class StockRentalController {
  constructor(private readonly rentals: StockRentalService) {}

  @Permissions('list_locacoes') @Get()
  list(@Req() req: Request, @Query() q: Q) { return this.rentals.list(stockActorOf(req), q ?? {}); }
  @Permissions('list_locacoes') @Get('options')
  options(@Req() req: Request) { return this.rentals.options(stockActorOf(req)); }
  @Permissions('list_locacoes') @Get('availability')
  availability(@Req() req: Request, @Query() q: Q) { return this.rentals.availability(stockActorOf(req), q ?? {}); }
  @Permissions('list_locacoes') @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.rentals.get(stockActorOf(req), id); }
  @Permissions('create_locacoes') @Post()
  create(@Req() req: Request, @Body() body: Json) { return this.rentals.create(stockActorOf(req), body ?? {}); }
  @Permissions('update_locacoes') @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.rentals.update(stockActorOf(req), id, body ?? {}); }
  @Permissions('update_locacoes', 'movimentar_estoque') @Post(':id/deliver') @HttpCode(200)
  deliver(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.rentals.deliver(stockActorOf(req), id, body ?? {}); }
  @Permissions('update_locacoes', 'movimentar_estoque') @Post(':id/return') @HttpCode(200)
  receiveBack(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.rentals.receiveBack(stockActorOf(req), id, body ?? {}); }
  @Permissions('update_locacoes', 'update_financeiro') @Post(':id/bill') @HttpCode(200)
  bill(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.rentals.bill(stockActorOf(req), id, body ?? {}); }
  @Permissions('update_locacoes') @Patch(':id/status')
  move(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.rentals.move(stockActorOf(req), id, body ?? {}); }
}
