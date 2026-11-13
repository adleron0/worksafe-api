import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from 'src/auth/decorators/public.decorator';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { DocumentService, VARIABLES } from './document.service';

const companyOf = (req: Request) => Number((req as Request & { user?: { companyId?: number } }).user?.companyId ?? 0);
type Json = Record<string, unknown>;

/** De onde veio o pedido (atrás do proxy), para a trilha de evidências do aceite. */
const metaOf = (req: Request) => {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = (first ? String(first).split(',')[0].trim() : (req.headers['x-real-ip'] as string) || req.ip || '') || null;
  return { ip: ip ? ip.slice(0, 64) : null, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 400) || null };
};

/** Modelos de proposta e termos jurídicos (cadastros do Comercial). */
@Controller('commercial')
export class DocumentController {
  constructor(private readonly documents: DocumentService) {}

  @Permissions('list_comercial') @Get('templates')
  templates(@Req() req: Request, @Query('inactive') inactive?: string) { return this.documents.listTemplates(companyOf(req), inactive === 'true'); }

  @Permissions('list_comercial') @Get('templates/variables')
  variables() { return VARIABLES; }

  @Permissions('create_comercial') @Post('templates')
  createTemplate(@Req() req: Request, @Body() body: Json) { return this.documents.createTemplate(companyOf(req), body ?? {}); }

  @Permissions('update_comercial') @Put('templates/:id')
  updateTemplate(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.documents.updateTemplate(companyOf(req), id, body ?? {}); }

  @Permissions('inactive_comercial') @Patch('templates/inactive/:id')
  inactivateTemplate(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.documents.setTemplateActive(companyOf(req), id, false); }

  @Permissions('activate_comercial') @Patch('templates/active/:id')
  activateTemplate(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.documents.setTemplateActive(companyOf(req), id, true); }

  @Permissions('list_comercial') @Get('terms')
  terms(@Req() req: Request, @Query('inactive') inactive?: string) { return this.documents.listTerms(companyOf(req), inactive === 'true'); }

  @Permissions('create_comercial') @Post('terms')
  createTerm(@Req() req: Request, @Body() body: Json) { return this.documents.createTerm(companyOf(req), body ?? {}); }

  @Permissions('update_comercial') @Put('terms/:id')
  updateTerm(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.documents.updateTerm(companyOf(req), id, body ?? {}); }

  @Permissions('inactive_comercial') @Patch('terms/inactive/:id')
  inactivateTerm(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.documents.setTermActive(companyOf(req), id, false); }

  @Permissions('activate_comercial') @Patch('terms/active/:id')
  activateTerm(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.documents.setTermActive(companyOf(req), id, true); }
}

/**
 * Link do cliente: sem login, só pela chave. Devolve apenas o documento
 * congelado e a situação; limite de requisições próprio contra força bruta
 * de chave e de código.
 */
@Controller('commercial/public/proposals')
export class PublicProposalController {
  constructor(private readonly documents: DocumentService) {}

  @Public() @Throttle({ default: { limit: 60, ttl: 60000 } }) @Get(':key')
  view(@Param('key') key: string, @Req() req: Request) { return this.documents.publicView(key, metaOf(req)); }

  @Public() @Throttle({ default: { limit: 5, ttl: 60000 } }) @Post(':key/code')
  code(@Param('key') key: string) { return this.documents.requestCode(key); }

  @Public() @Throttle({ default: { limit: 10, ttl: 60000 } }) @Post(':key/accept')
  accept(@Param('key') key: string, @Req() req: Request, @Body() body: Json) { return this.documents.accept(key, body ?? {}, metaOf(req)); }

  @Public() @Throttle({ default: { limit: 10, ttl: 60000 } }) @Post(':key/refuse')
  refuse(@Param('key') key: string, @Req() req: Request, @Body() body: Json) { return this.documents.refuse(key, body ?? {}, metaOf(req)); }
}
