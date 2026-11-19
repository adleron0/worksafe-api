import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { Public } from 'src/auth/decorators/public.decorator';
import { ALL_PROPOSALS_PERMISSION } from './ownership';
import { COSTS_PERMISSION, permissionsOf } from './proposal.controller';
import { Actor } from './proposal.service';
import { DealService } from './deal.service';

const actorOf = (req: Request): Actor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number; permissions?: unknown } }).user;
  const permissions = permissionsOf(user?.permissions);
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0), canSeeCosts: permissions.includes(COSTS_PERMISSION), seesAll: permissions.includes(ALL_PROPOSALS_PERMISSION) };
};
type Json = Record<string, unknown>;

/** Negociações: propostas do mesmo cliente agrupadas, com o desconto de fechamento conjunto. */
@Controller('commercial/deals')
export class DealController {
  constructor(private readonly deals: DealService) {}

  @Permissions('list_comercial') @Get()
  list(@Req() req: Request, @Query() query: Record<string, string>) { return this.deals.list(actorOf(req), query ?? {}); }

  @Permissions('list_comercial') @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.deals.get(actorOf(req), id); }

  @Permissions('list_comercial') @Get(':id/candidates')
  candidates(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.deals.candidates(actorOf(req), id); }

  @Permissions('create_comercial') @Post()
  create(@Req() req: Request, @Body() body: Json) { return this.deals.create(actorOf(req), body ?? {}); }

  @Permissions('update_comercial') @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.deals.update(actorOf(req), id, body ?? {}); }

  @Permissions('update_comercial') @Post(':id/proposals')
  add(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.deals.addProposals(actorOf(req), id, body ?? {}); }

  @Permissions('update_comercial') @Delete(':id/proposals/:proposalId')
  remove(@Param('id', ParseIntPipe) id: number, @Param('proposalId', ParseIntPipe) proposalId: number, @Req() req: Request) { return this.deals.removeProposal(actorOf(req), id, proposalId); }

  @Permissions('list_comercial') @Post(':id/discount/preview')
  preview(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.deals.previewDiscount(actorOf(req), id, body ?? {}); }

  @Permissions('update_comercial') @Post(':id/discount/apply')
  apply(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.deals.applyDiscount(actorOf(req), id, body ?? {}); }

  @Permissions('update_comercial') @Post(':id/breach/dismiss')
  dismiss(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.deals.dismissBreach(actorOf(req), id); }

  @Permissions('update_comercial') @Post(':id/link')
  link(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.deals.createLink(actorOf(req), id); }

  @Permissions('update_comercial') @Patch(':id/inactive')
  inactivate(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.deals.inactivate(actorOf(req), id); }
}

/** Link do cliente para a negociação: só a lista das propostas enviadas, cada uma com o próprio link de aceite. */
@Controller('commercial/public/deals')
export class PublicDealController {
  constructor(private readonly deals: DealService) {}

  @Public() @Throttle({ default: { limit: 60, ttl: 60000 } }) @Get(':key')
  view(@Param('key') key: string) { return this.deals.publicView(key); }
}
