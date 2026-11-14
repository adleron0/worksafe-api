import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { SellerWalletService, WalletActor } from './wallet.service';

const actorOf = (req: Request): WalletActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0) };
};
type Json = Record<string, unknown>;

/**
 * Vendedores e a carteira de comissões de cada um. Ver a carteira pede a permissão
 * de listar do comercial; marcar vendedor, pagar, ajustar e estornar pedem a de alterar.
 */
@Controller('commercial/sellers')
export class SellerWalletController {
  constructor(private readonly wallets: SellerWalletService) {}

  @Permissions('list_comercial') @Get()
  list(@Req() req: Request, @Query() query: Record<string, string>) { return this.wallets.list(actorOf(req).companyId, query ?? {}); }

  // estática antes de :id, senão "candidates" seria lido como um id
  @Permissions('update_comercial') @Get('candidates')
  candidates(@Req() req: Request, @Query() query: Record<string, string>) { return this.wallets.candidates(actorOf(req).companyId, query ?? {}); }

  @Permissions('update_comercial') @Post('entries/:entryId/reverse')
  reverse(@Param('entryId', ParseIntPipe) entryId: number, @Req() req: Request, @Body() body: Json) { return this.wallets.reverse(actorOf(req), entryId, body ?? {}); }

  @Permissions('list_comercial') @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.wallets.detail(actorOf(req).companyId, id); }

  @Permissions('list_comercial') @Get(':id/entries')
  entries(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Query() query: Record<string, string>) { return this.wallets.entries(actorOf(req).companyId, id, query ?? {}); }

  @Permissions('update_comercial') @Post(':id')
  mark(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.wallets.mark(actorOf(req), id); }

  @Permissions('update_comercial') @Delete(':id')
  unmark(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.wallets.unmark(actorOf(req), id); }

  @Permissions('update_comercial') @Post(':id/payments')
  pay(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.wallets.pay(actorOf(req), id, body ?? {}); }

  @Permissions('update_comercial') @Post(':id/adjustments')
  adjust(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.wallets.adjust(actorOf(req), id, body ?? {}); }
}
