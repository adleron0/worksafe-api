import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { RetentionActor, RetentionService } from './retention.service';

const actorOf = (req: Request): RetentionActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0) };
};
type Q = Record<string, unknown>;

/** Impostos retidos pelos clientes: relatório mensal, alertas de duplicidade e retenções de cada conta a receber. */
@Controller('financial')
export class RetentionController {
  constructor(private readonly retentions: RetentionService) {}

  @Permissions('list_financeiro') @Get('retentions')
  report(@Req() req: Request, @Query() query: Q) { return this.retentions.report(actorOf(req).companyId, query ?? {}); }

  @Permissions('update_financeiro') @Post('retentions/declare')
  declare(@Req() req: Request, @Body() body: Q) { return this.retentions.declare(actorOf(req), body ?? {}); }

  @Permissions('list_financeiro') @Get('receivables/:id/retentions')
  ofRecord(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.retentions.ofRecord(actorOf(req).companyId, id); }

  @Permissions('update_financeiro') @Put('receivables/:id/retentions')
  set(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Q) { return this.retentions.setForRecord(actorOf(req), id, body ?? {}); }
}
