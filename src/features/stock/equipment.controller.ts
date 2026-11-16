import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { StockEquipmentService } from './equipment.service';
import { stockActorOf } from './stock.controller';
import { requireAny } from './stock.rules';

type Json = Record<string, unknown>;
type Q = Record<string, string>;

/** Equipamentos rastreados: peças, lotes, inspeções, calibração e manutenção. */
@Controller('stock')
export class StockEquipmentController {
  constructor(private readonly equipment: StockEquipmentService) {}

  @Permissions('list_equipamentos') @Get('units')
  units(@Req() req: Request, @Query() q: Q) { return this.equipment.units(stockActorOf(req), q ?? {}); }
  /** Etiqueta (QR) → peça. Quem inspeciona em campo também abre. */
  @Get('units/by-tag/:tag')
  byTag(@Param('tag') tag: string, @Req() req: Request) {
    const actor = stockActorOf(req);
    requireAny(actor, ['list_equipamentos', 'inspecoes_equipamentos', 'movimentar_estoque']);
    return this.equipment.byTag(actor, tag);
  }
  @Get('units/:id')
  unit(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const actor = stockActorOf(req);
    requireAny(actor, ['list_equipamentos', 'inspecoes_equipamentos', 'movimentar_estoque']);
    return this.equipment.unit(actor, id);
  }
  @Permissions('update_equipamentos') @Put('units/:id')
  updateUnit(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.equipment.updateUnit(stockActorOf(req), id, body ?? {}); }
  /** Bloquear e liberar pedem editar equipamento; pedir inspeção extraordinária, só quem inspeciona ou movimenta. */
  @Patch('units/:id/state')
  setState(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) {
    const actor = stockActorOf(req);
    requireAny(actor, body?.action === 'extraordinaria' ? ['update_equipamentos', 'inspecoes_equipamentos', 'movimentar_estoque'] : ['update_equipamentos']);
    return this.equipment.setState(actor, id, body ?? {});
  }
  @Permissions('inactive_equipamentos') @Post('units/:id/retire') @HttpCode(200)
  retire(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.equipment.retire(stockActorOf(req), id, body ?? {}); }
  @Permissions('update_equipamentos') @Post('units/:id/cut') @HttpCode(200)
  cut(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.equipment.cut(stockActorOf(req), id, body ?? {}); }
  @Permissions('inactive_equipamentos') @Post('lots/:id/retire') @HttpCode(200)
  retireLot(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.equipment.retireFromLot(stockActorOf(req), id, body ?? {}); }

  // roteiros
  @Get('inspection-templates')
  templates(@Req() req: Request, @Query() q: Q) {
    const actor = stockActorOf(req);
    requireAny(actor, ['view_inspecoes_equipamentos', 'inspecoes_equipamentos', 'list_itens_estoque']);
    return this.equipment.templates(actor, q ?? {});
  }
  @Permissions('inspecoes_equipamentos') @Post('inspection-templates')
  createTemplate(@Req() req: Request, @Body() body: Json) { return this.equipment.createTemplate(stockActorOf(req), body ?? {}); }
  @Permissions('inspecoes_equipamentos') @Put('inspection-templates/:id')
  updateTemplate(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.equipment.updateTemplate(stockActorOf(req), id, body ?? {}); }

  // inspeções
  @Get('inspections')
  inspections(@Req() req: Request, @Query() q: Q) {
    const actor = stockActorOf(req);
    requireAny(actor, ['view_inspecoes_equipamentos', 'list_equipamentos']);
    return this.equipment.inspections(actor, q ?? {});
  }
  @Permissions('inspecoes_equipamentos') @Post('inspections')
  inspect(@Req() req: Request, @Body() body: Json) { return this.equipment.inspect(stockActorOf(req), body ?? {}); }

  // vencimentos
  @Permissions('list_equipamentos') @Get('dues')
  dues(@Req() req: Request, @Query() q: Q) { return this.equipment.dues(stockActorOf(req), q ?? {}); }

  // calibração e manutenção
  @Permissions('list_equipamentos') @Get('services')
  services(@Req() req: Request, @Query() q: Q) { return this.equipment.services(stockActorOf(req), q ?? {}); }
  @Permissions('list_equipamentos') @Get('services/:id')
  event(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.equipment.event(stockActorOf(req), id); }
  @Permissions('update_equipamentos') @Post('units/:id/service')
  send(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.equipment.sendToService(stockActorOf(req), id, body ?? {}); }
  @Permissions('update_equipamentos') @Post('services/:id/return') @HttpCode(200)
  back(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.equipment.returnFromService(stockActorOf(req), id, body ?? {}); }
  @Permissions('update_equipamentos') @Post('services/:id/cancel') @HttpCode(200)
  cancel(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.equipment.cancelService(stockActorOf(req), id); }
  @Permissions('update_equipamentos') @Put('services/:id/purchase')
  link(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.equipment.linkPurchase(stockActorOf(req), id, body ?? {}); }
}
