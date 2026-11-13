import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { CommercialService } from './commercial.service';

const companyOf = (req: Request) => Number((req as Request & { user?: { companyId?: number } }).user?.companyId ?? 0);
type Json = Record<string, unknown>;

/**
 * Comercial — base de cálculo, perfis tributários e o motor de preços.
 * Fora do CRUD genérico: a base é um documento (parâmetros + itens) com
 * vigência, e o cálculo é regra, não cadastro.
 */
@Controller('commercial')
export class CommercialController {
  constructor(private readonly commercial: CommercialService) {}

  // ---- base de custos
  @Permissions('list_comercial') @Get('cost-bases')
  bases(@Req() req: Request, @Query('date') date?: string) { return this.commercial.listBases(companyOf(req), date || undefined); }

  @Permissions('list_comercial') @Get('cost-bases/current')
  current(@Req() req: Request, @Query('date') date?: string) { return this.commercial.getBase(companyOf(req), 'current', date || undefined); }

  @Permissions('list_comercial') @Get('cost-bases/:id')
  base(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Query('date') date?: string) {
    return this.commercial.getBase(companyOf(req), id, date || undefined);
  }

  @Permissions('list_comercial') @Post('cost-bases/compute')
  compute(@Req() req: Request, @Body() body: Json) { return this.commercial.computeDraft(companyOf(req), body ?? {}); }

  @Permissions('create_comercial') @Post('cost-bases')
  createBase(@Req() req: Request, @Body() body: Json) { return this.commercial.createBase(companyOf(req), body ?? {}); }

  @Permissions('update_comercial') @Put('cost-bases/:id')
  updateBase(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) {
    return this.commercial.updateBase(companyOf(req), id, body ?? {});
  }

  @Permissions('inactive_comercial') @Patch('cost-bases/inactive/:id')
  inactivateBase(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.commercial.setBaseActive(companyOf(req), id, false); }

  @Permissions('activate_comercial') @Patch('cost-bases/active/:id')
  activateBase(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.commercial.setBaseActive(companyOf(req), id, true); }

  // ---- perfis tributários
  @Permissions('list_comercial') @Get('tax-profiles')
  taxProfiles(@Req() req: Request, @Query('date') date?: string) { return this.commercial.listTaxProfiles(companyOf(req), date || undefined); }

  @Permissions('create_comercial') @Post('tax-profiles')
  createTax(@Req() req: Request, @Body() body: Json) { return this.commercial.createTaxProfile(companyOf(req), body ?? {}); }

  @Permissions('update_comercial') @Put('tax-profiles/:id')
  updateTax(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) {
    return this.commercial.updateTaxProfile(companyOf(req), id, body ?? {});
  }

  @Permissions('update_comercial') @Patch('tax-profiles/default/:id')
  defaultTax(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.commercial.setDefaultTaxProfile(companyOf(req), id); }

  @Permissions('inactive_comercial') @Patch('tax-profiles/inactive/:id')
  inactivateTax(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.commercial.setTaxActive(companyOf(req), id, false); }

  @Permissions('activate_comercial') @Patch('tax-profiles/active/:id')
  activateTax(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.commercial.setTaxActive(companyOf(req), id, true); }

  // ---- motor
  @Permissions('list_comercial') @Get('pricing/context')
  context(@Req() req: Request, @Query() query: Record<string, string>) { return this.commercial.context(companyOf(req), query ?? {}); }

  @Permissions('list_comercial') @Post('pricing/preview')
  preview(@Req() req: Request, @Body() body: Json) { return this.commercial.preview(companyOf(req), body ?? {}); }
}
