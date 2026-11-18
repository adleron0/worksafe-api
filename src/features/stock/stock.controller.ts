import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { permissionsOf } from 'src/features/commercial/proposal.controller';
import { StockCatalogService } from './catalog.service';
import { StockMovementService } from './movement.service';
import { StockActor, requireAny } from './stock.rules';

export const stockActorOf = (req: Request): StockActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number; permissions?: unknown } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0), permissions: permissionsOf(user?.permissions) };
};
type Json = Record<string, unknown>;
type Q = Record<string, string>;
const PICKERS = ['list_itens_estoque', 'movimentar_estoque', 'create_pedidos_de_compra', 'update_pedidos_de_compra', 'create_entregas_epi', 'create_locacoes', 'update_locacoes', 'list_equipamentos', 'inspecoes_equipamentos', 'update_comercial'];

/** Estoque: catálogo, locais, saldos e movimentações. */
@Controller('stock')
export class StockController {
  constructor(private readonly catalog: StockCatalogService, private readonly movements: StockMovementService) {}

  /** Opções dos formulários: também para quem só movimenta, compra, entrega EPI ou aluga. */
  @Get('options')
  options(@Req() req: Request) {
    const actor = stockActorOf(req);
    requireAny(actor, PICKERS);
    return this.catalog.options(actor);
  }

  /** Peças de um item (para escolher na saída, transferência, entrega ou locação). */
  @Get('units/options')
  unitOptions(@Req() req: Request, @Query() q: Q) {
    const actor = stockActorOf(req);
    requireAny(actor, PICKERS);
    return this.catalog.unitOptions(actor, q ?? {});
  }

  /** Lotes de um item com saldo num local. */
  @Get('lots/options')
  lotOptions(@Req() req: Request, @Query() q: Q) {
    const actor = stockActorOf(req);
    requireAny(actor, PICKERS);
    return this.catalog.lotOptions(actor, q ?? {});
  }

  /** Ordens de serviço abertas que a pessoa vê (entrega de EPI marcada para uma obra, locação junto de serviço). */
  @Get('service-orders/options')
  orderOptions(@Req() req: Request) {
    const actor = stockActorOf(req);
    requireAny(actor, PICKERS);
    return this.movements.orderOptions(actor);
  }

  /** Funcionários ativos (inspetor, quem recebe). */
  @Get('employees/options')
  employeeOptions(@Req() req: Request) {
    const actor = stockActorOf(req);
    requireAny(actor, PICKERS);
    return this.movements.employeeOptions(actor);
  }

  /** Fornecedores em Suprimentos (sem dados bancários). */
  @Get('suppliers')
  suppliers(@Req() req: Request, @Query() q: Q) {
    const actor = stockActorOf(req);
    requireAny(actor, ['view_fornecedores_suprimentos', 'list_pedidos_de_compra', 'list_equipamentos']);
    return this.catalog.suppliers(actor, q ?? {});
  }

  @Permissions('list_itens_estoque') @Get('overview')
  overview(@Req() req: Request) { return this.movements.overview(stockActorOf(req)); }

  // categorias
  @Permissions('list_itens_estoque') @Get('categories')
  categories(@Req() req: Request, @Query() q: Q) { return this.catalog.categories(stockActorOf(req), q ?? {}); }
  @Permissions('create_itens_estoque') @Post('categories')
  createCategory(@Req() req: Request, @Body() body: Json) { return this.catalog.createCategory(stockActorOf(req), body ?? {}); }
  @Permissions('update_itens_estoque') @Put('categories/:id')
  updateCategory(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.catalog.updateCategory(stockActorOf(req), id, body ?? {}); }
  @Permissions('inactive_itens_estoque') @Patch('categories/:id/inactive')
  inactivateCategory(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.catalog.setCategoryActive(stockActorOf(req), id, false); }
  @Permissions('activate_itens_estoque') @Patch('categories/:id/active')
  activateCategory(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.catalog.setCategoryActive(stockActorOf(req), id, true); }

  // locais
  @Permissions('list_itens_estoque') @Get('locations')
  locations(@Req() req: Request, @Query() q: Q) { return this.catalog.locations(stockActorOf(req), q ?? {}); }
  @Permissions('create_itens_estoque') @Post('locations')
  createLocation(@Req() req: Request, @Body() body: Json) { return this.catalog.createLocation(stockActorOf(req), body ?? {}); }
  @Permissions('update_itens_estoque') @Put('locations/:id')
  updateLocation(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.catalog.updateLocation(stockActorOf(req), id, body ?? {}); }
  @Permissions('inactive_itens_estoque') @Patch('locations/:id/inactive')
  inactivateLocation(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.catalog.setLocationActive(stockActorOf(req), id, false); }
  @Permissions('activate_itens_estoque') @Patch('locations/:id/active')
  activateLocation(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.catalog.setLocationActive(stockActorOf(req), id, true); }

  // itens
  @Permissions('list_itens_estoque') @Get('items')
  items(@Req() req: Request, @Query() q: Q) { return this.catalog.items(stockActorOf(req), q ?? {}); }
  /** Lista enxuta para escolher item: quem movimenta (encarregado), compra ou entrega EPI. */
  @Get('items/options')
  itemOptions(@Req() req: Request, @Query() q: Q) {
    const actor = stockActorOf(req);
    requireAny(actor, ['list_itens_estoque', 'movimentar_estoque', 'create_pedidos_de_compra', 'update_pedidos_de_compra', 'create_entregas_epi', 'create_locacoes', 'update_comercial']);
    return this.catalog.itemOptions(actor, q ?? {});
  }
  /** Valores de pesquisa da locação (plano 09) para preencher item ou categoria. */
  @Permissions('list_itens_estoque') @Get('items/rental-presets')
  rentalPresets() { return this.catalog.rentalPresets(); }
  /** Recalcula dia/semana/mês dos itens alugáveis no modo "calculado" (depois de mudar a base de cálculo). */
  @Permissions('update_itens_estoque') @Post('items/rental-prices/refresh') @HttpCode(200)
  refreshRentPrices(@Req() req: Request) { return this.catalog.refreshAllRentPrices(stockActorOf(req)); }
  @Permissions('list_itens_estoque') @Get('items/:id')
  item(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.catalog.item(stockActorOf(req), id); }
  @Permissions('list_itens_estoque') @Get('items/:id/movements')
  kardex(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Query() q: Q) { return this.catalog.kardex(stockActorOf(req), id, q ?? {}); }
  @Permissions('list_itens_estoque') @Get('items/:id/purchases')
  itemPurchases(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.catalog.purchases(stockActorOf(req), id); }
  @Permissions('create_itens_estoque') @Post('items')
  createItem(@Req() req: Request, @Body() body: Json) { return this.catalog.createItem(stockActorOf(req), body ?? {}); }
  @Permissions('update_itens_estoque') @Put('items/:id')
  updateItem(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.catalog.updateItem(stockActorOf(req), id, body ?? {}); }
  @Permissions('inactive_itens_estoque') @Patch('items/:id/inactive')
  inactivateItem(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.catalog.setItemActive(stockActorOf(req), id, false); }
  @Permissions('activate_itens_estoque') @Patch('items/:id/active')
  activateItem(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.catalog.setItemActive(stockActorOf(req), id, true); }

  // saldos e movimentações
  @Permissions('list_itens_estoque') @Get('balances')
  balances(@Req() req: Request, @Query() q: Q) { return this.movements.balances(stockActorOf(req), q ?? {}); }
  @Permissions('list_itens_estoque') @Get('reorder')
  reorder(@Req() req: Request) { return this.movements.reorder(stockActorOf(req)); }
  @Permissions('list_itens_estoque') @Get('movements')
  list(@Req() req: Request, @Query() q: Q) { return this.movements.list(stockActorOf(req), q ?? {}); }
  @Permissions('list_itens_estoque') @Get('movements/:id')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.movements.get(stockActorOf(req), id); }
  /** A permissão de cada tipo (movimentar ou ajustar) é conferida no serviço. */
  @Post('movements')
  create(@Req() req: Request, @Body() body: Json) {
    const actor = stockActorOf(req);
    requireAny(actor, ['movimentar_estoque', 'ajuste_estoque']);
    return this.movements.create(actor, body ?? {});
  }
  @Permissions('ajuste_estoque') @Post('movements/:id/reverse') @HttpCode(200)
  reverse(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.movements.reverse(stockActorOf(req), id, body ?? {}); }
  @Permissions('ajuste_estoque') @Post('import') @HttpCode(200)
  importCsv(@Req() req: Request, @Body() body: Json) { return this.movements.importCsv(stockActorOf(req), body ?? {}); }

  // obra
  @Permissions('list_ordens_de_servico') @Get('service-orders/:orderId')
  ofOrder(@Param('orderId', ParseIntPipe) orderId: number, @Req() req: Request) { return this.movements.ofOrder(stockActorOf(req), orderId); }
  @Permissions('movimentar_estoque') @Post('service-orders/:orderId/dispatch')
  dispatch(@Param('orderId', ParseIntPipe) orderId: number, @Req() req: Request, @Body() body: Json) { return this.movements.dispatch(stockActorOf(req), orderId, body ?? {}); }
  @Permissions('movimentar_estoque') @Post('service-orders/:orderId/return')
  returnFromOrder(@Param('orderId', ParseIntPipe) orderId: number, @Req() req: Request, @Body() body: Json) { return this.movements.returnFromOrder(stockActorOf(req), orderId, body ?? {}); }
  @Permissions('movimentar_estoque') @Post('service-orders/:orderId/consume')
  consume(@Param('orderId', ParseIntPipe) orderId: number, @Req() req: Request, @Body() body: Json) { return this.movements.consumeAtOrder(stockActorOf(req), orderId, body ?? {}); }
}
