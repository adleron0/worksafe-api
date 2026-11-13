import { Body, Controller, Get, Param, ParseIntPipe, Patch, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { Public } from 'src/auth/decorators/public.decorator';
import { Actor, FinancialrecordsService, SettleInput } from './service';

const actorOf = (req: Request): Actor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0) };
};

@Controller('financial-records')
export class FinancialRecordsCustomController {
  constructor(private readonly records: FinancialrecordsService) {}

  /** Consulta pública de um registro pela key (UUID) — usada no checkout/boleto. */
  @Public() @Get('key/:key')
  byKey(@Param('key') key: string) {
    return this.records.getFinancialRecordByKey(key);
  }

  /** Baixa manual de um recebível manual em aberto. */
  @Permissions('update_financeiro') @Patch('settle/:id')
  settle(@Param('id', ParseIntPipe) id: number, @Body() body: SettleInput, @Req() req: Request) {
    return this.records.settle(id, body ?? {}, actorOf(req));
  }

  /** Estorno da baixa manual. */
  @Permissions('update_financeiro') @Patch('unsettle/:id')
  unsettle(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.records.unsettle(id, actorOf(req));
  }
}
