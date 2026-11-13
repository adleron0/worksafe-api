import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { ChartAccountService } from './chart-account.service';
import { FinancialService } from './financial.service';

const actorOf = (req: Request) => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0) };
};

/**
 * Plano de contas e apoio do financeiro. O plano não usa o CRUD genérico:
 * código, nível e natureza são derivados da conta mãe, e criar/mover mexe em
 * mais de uma linha — tudo isso é regra, não cadastro simples.
 */
@Controller('financial')
export class FinancialController {
  constructor(private readonly chart: ChartAccountService, private readonly financial: FinancialService) {}

  @Permissions('list_financeiro') @Get('chart-accounts')
  list(@Req() req: Request, @Query('month') month?: string, @Query('inactive') inactive?: string) {
    return this.chart.list(actorOf(req).companyId, { month: month || undefined, includeInactive: inactive === 'true' });
  }

  @Permissions('create_financeiro') @Post('chart-accounts')
  create(@Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.chart.create(body ?? {}, actorOf(req));
  }

  @Permissions('update_financeiro') @Put('chart-accounts/:id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.chart.update(id, body ?? {}, actorOf(req));
  }

  @Permissions('update_financeiro') @Patch('chart-accounts/move/:id')
  move(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.chart.move(id, body?.parentId, actorOf(req));
  }

  @Permissions('inactive_financeiro') @Patch('chart-accounts/inactive/:id')
  inactivate(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.chart.setActive(id, false, actorOf(req));
  }

  @Permissions('activate_financeiro') @Patch('chart-accounts/active/:id')
  activate(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.chart.setActive(id, true, actorOf(req));
  }

  @Permissions('list_financeiro') @Get('bank-balances')
  bankBalances(@Req() req: Request) {
    return this.financial.bankBalances(actorOf(req).companyId);
  }

  @Permissions('list_financeiro') @Get('classification-defaults')
  defaults(@Req() req: Request) {
    return this.financial.classificationDefaults(actorOf(req).companyId);
  }

  @Permissions('update_financeiro') @Put('classification-defaults/:origin')
  setDefault(@Param('origin') origin: string, @Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.financial.setClassificationDefault(actorOf(req).companyId, origin, body ?? {});
  }

  @Permissions('update_financeiro') @Post('classification-defaults/apply')
  applyDefaults(@Req() req: Request) {
    return this.financial.applyDefaultsToSubscriptions(actorOf(req).companyId);
  }
}
