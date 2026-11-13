import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import * as Zlib from 'zlib';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { Actor, ProposalService } from './proposal.service';

/** Quem vê custo, margem, lucro e comissão dentro da proposta. */
export const COSTS_PERMISSION = 'view_custos_comercial';

/**
 * Permissões do token. O login grava a lista compactada (deflate + base64);
 * o guard a expande só para conferir a rota e deixa o `req.user` como veio.
 */
export function permissionsOf(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const list = JSON.parse(Zlib.inflateRawSync(Buffer.from(raw, 'base64')).toString());
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
}

const actorOf = (req: Request): Actor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number; permissions?: unknown } }).user;
  return {
    userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0),
    canSeeCosts: permissionsOf(user?.permissions).includes(COSTS_PERMISSION),
  };
};
type Json = Record<string, unknown>;

/**
 * Propostas comerciais (serviço e treinamento são a mesma proposta, com itens
 * de tipos diferentes). Fora do CRUD genérico: a proposta é um documento
 * (cabeçalho + seções + itens + parcelas) calculado pelo motor a cada gravação.
 */
@Controller('commercial')
export class ProposalController {
  constructor(private readonly proposals: ProposalService) {}

  @Permissions('list_comercial') @Get('proposals')
  list(@Req() req: Request, @Query() query: Record<string, string>) { return this.proposals.list(actorOf(req), query ?? {}); }

  @Permissions('list_comercial') @Get('proposals/options')
  options(@Req() req: Request, @Query() query: Record<string, string>) { return this.proposals.options(actorOf(req), query ?? {}); }

  @Permissions('list_comercial') @Get('proposals/customers')
  customers(@Req() req: Request, @Query('search') search?: string) { return this.proposals.customers(actorOf(req), search); }

  @Permissions('list_comercial') @Post('proposals/preview')
  preview(@Req() req: Request, @Body() body: Json) { return this.proposals.preview(actorOf(req), body ?? {}); }

  @Permissions('list_comercial') @Get('proposals/:id')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.proposals.get(actorOf(req), id); }

  @Permissions('create_comercial') @Post('proposals')
  create(@Req() req: Request, @Body() body: Json) { return this.proposals.create(actorOf(req), body ?? {}); }

  @Permissions('update_comercial') @Put('proposals/:id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.proposals.update(actorOf(req), id, body ?? {}); }

  @Permissions('list_comercial') @Post('proposals/:id/document-preview')
  documentPreview(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.proposals.documentPreview(actorOf(req), id, body ?? {}); }

  @Permissions('list_comercial') @Get('proposals/:id/client-view')
  clientView(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.proposals.clientView(actorOf(req), id); }

  @Permissions('update_comercial') @Post('proposals/:id/send-email')
  sendEmail(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.proposals.sendEmail(actorOf(req), id, body ?? {}); }

  @Permissions('create_comercial') @Post('proposals/:id/duplicate')
  duplicate(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.proposals.duplicate(actorOf(req), id); }

  @Permissions('create_comercial') @Post('proposals/:id/revise')
  revise(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.proposals.revise(actorOf(req), id); }

  @Permissions('update_comercial') @Patch('proposals/status/:id')
  status(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.proposals.setStatus(actorOf(req), id, body ?? {}); }

  @Permissions('inactive_comercial') @Patch('proposals/inactive/:id')
  inactivate(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.proposals.setActive(actorOf(req), id, false); }

  @Permissions('activate_comercial') @Patch('proposals/active/:id')
  activate(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.proposals.setActive(actorOf(req), id, true); }

  // ---- tabela de preço in-company dos cursos
  @Permissions('list_comercial') @Get('course-prices')
  coursePrices(@Req() req: Request) { return this.proposals.coursePrices(actorOf(req)); }

  @Permissions('update_comercial') @Put('course-prices/:courseId')
  setCoursePrice(@Param('courseId', ParseIntPipe) courseId: number, @Req() req: Request, @Body() body: Json) {
    return this.proposals.setCoursePrice(actorOf(req), courseId, body ?? {});
  }
}
