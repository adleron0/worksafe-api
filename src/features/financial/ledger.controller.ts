import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { memoryStorage } from 'multer';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { buildXlsx } from 'src/common/xlsx';
import { FinancialrecordsService } from 'src/features/gateway/financialrecords/service';
import { LedgerService, exportName } from './ledger.service';
import { PayableActor, PayableService } from './payable.service';
import { RecurrenceService } from './recurrence.service';
import { ReportService } from './report.service';
import { StatementDraftService } from './statement-draft.service';
import { TreasuryService } from './treasury.service';

type Q = Record<string, unknown>;
const actorOf = (req: Request): PayableActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0) };
};
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function sendXlsx(res: Response, name: string, data: Buffer) {
  res.setHeader('Content-Type', XLSX);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.send(data);
}

/**
 * Financeiro, parte operacional: listas filtradas de contas a pagar e a
 * receber (com totais e exportação), operações em lote, parcelamentos,
 * lançamentos recorrentes, relatórios, transferências e conciliação.
 */
@Controller('financial')
export class LedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly payables: PayableService,
    private readonly receivables: FinancialrecordsService,
    private readonly recurrences: RecurrenceService,
    private readonly reports: ReportService,
    private readonly treasury: TreasuryService,
    private readonly drafts: StatementDraftService,
  ) {}

  // ------------------------------------------------------------ a pagar
  @Permissions('list_financeiro') @Get('payables')
  listPayables(@Req() req: Request, @Query() query: Q) { return this.ledger.payables(actorOf(req).companyId, query); }

  @Permissions('list_financeiro') @Get('payables/export')
  async exportPayables(@Req() req: Request, @Query() query: Q, @Res() res: Response) {
    sendXlsx(res, exportName('contas-a-pagar'), await this.ledger.exportPayables(actorOf(req).companyId, query));
  }

  @Permissions('update_financeiro') @Post('payables/bulk-settle')
  bulkSettlePayables(@Req() req: Request, @Body() body: Q) { return this.payables.bulkSettle(actorOf(req), body ?? {}); }

  @Permissions('inactive_financeiro') @Post('payables/bulk-archive')
  bulkArchivePayables(@Req() req: Request, @Body() body: Q) { return this.payables.bulkArchive(actorOf(req), body ?? {}); }

  @Permissions('update_financeiro') @Put('payables/group/:groupKey')
  updateGroup(@Req() req: Request, @Param('groupKey') groupKey: string, @Body() body: Q) { return this.payables.updateGroup(actorOf(req), groupKey, body ?? {}); }

  // ------------------------------------------------------------ a receber
  @Permissions('list_financeiro') @Get('receivables')
  listReceivables(@Req() req: Request, @Query() query: Q) { return this.ledger.receivables(actorOf(req).companyId, query); }

  @Permissions('list_financeiro') @Get('receivables/export')
  async exportReceivables(@Req() req: Request, @Query() query: Q, @Res() res: Response) {
    sendXlsx(res, exportName('contas-a-receber'), await this.ledger.exportReceivables(actorOf(req).companyId, query));
  }

  @Permissions('update_financeiro') @Post('receivables/bulk-settle')
  bulkSettleReceivables(@Req() req: Request, @Body() body: Q) { return this.receivables.bulkSettle(actorOf(req), body ?? {}); }

  @Permissions('inactive_financeiro') @Post('receivables/bulk-archive')
  bulkArchiveReceivables(@Req() req: Request, @Body() body: Q) { return this.receivables.bulkArchive(actorOf(req), body ?? {}); }

  // ------------------------------------------------------------ recorrentes
  @Permissions('list_financeiro') @Get('recurrences')
  listRecurrences(@Req() req: Request, @Query('kind') kind?: string) {
    return this.recurrences.list(actorOf(req).companyId, kind === 'payable' || kind === 'receivable' ? kind : undefined);
  }

  @Permissions('create_financeiro') @Post('recurrences')
  createRecurrence(@Req() req: Request, @Body() body: Q) { return this.recurrences.create(actorOf(req), body ?? {}); }

  @Permissions('update_financeiro') @Put('recurrences/:id')
  updateRecurrence(@Req() req: Request, @Param('id', ParseIntPipe) id: number, @Body() body: Q) { return this.recurrences.update(id, actorOf(req), body ?? {}); }

  @Permissions('inactive_financeiro') @Patch('recurrences/:id/end')
  endRecurrence(@Req() req: Request, @Param('id', ParseIntPipe) id: number, @Body() body: Q) { return this.recurrences.end(id, actorOf(req), body ?? {}); }

  // ------------------------------------------------------------ relatórios
  @Permissions('list_financeiro') @Get('reports/cash-flow')
  async cashFlow(@Req() req: Request, @Query() query: Q, @Res({ passthrough: true }) res: Response) {
    const data = await this.reports.cashFlow(actorOf(req).companyId, query);
    if (query.format !== 'xlsx') return data;
    sendXlsx(res, exportName('fluxo-de-caixa'), buildXlsx([this.reports.cashFlowSheet(data)]));
    return undefined;
  }

  @Permissions('list_financeiro') @Get('reports/dre')
  async dre(@Req() req: Request, @Query() query: Q, @Res({ passthrough: true }) res: Response) {
    const data = await this.reports.dre(actorOf(req).companyId, query);
    if (query.format !== 'xlsx') return data;
    sendXlsx(res, exportName('dre'), buildXlsx([this.reports.dreSheet(data)]));
    return undefined;
  }

  // ------------------------------------------------------------ tesouraria
  @Permissions('list_financeiro') @Get('transfers')
  listTransfers(@Req() req: Request, @Query() query: Q) { return this.treasury.transfers(actorOf(req).companyId, query); }

  @Permissions('create_financeiro') @Post('transfers')
  createTransfer(@Req() req: Request, @Body() body: Q) { return this.treasury.createTransfer(actorOf(req), body ?? {}); }

  @Permissions('inactive_financeiro') @Patch('transfers/:id/inactive')
  archiveTransfer(@Req() req: Request, @Param('id', ParseIntPipe) id: number) { return this.treasury.archiveTransfer(actorOf(req), id); }

  @Permissions('update_financeiro') @Post('reconciliation/preview')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  preview(@Req() req: Request, @Body() body: Q, @UploadedFile() file?: Express.Multer.File) {
    const content = file?.buffer ? decodeOfx(file.buffer) : String(body?.content ?? '');
    if (!content.trim()) throw new BadRequestException('Envie o arquivo OFX do extrato');
    return this.treasury.preview(actorOf(req).companyId, body?.bankAccountId, content);
  }

  @Permissions('update_financeiro') @Post('reconciliation/apply')
  apply(@Req() req: Request, @Body() body: Q) { return this.treasury.apply(actorOf(req), body ?? {}); }

  // ------------------------------------------------------------ extratos lidos (PDF / MCP)

  @Permissions('list_financeiro') @Get('statement-drafts')
  listDrafts(@Req() req: Request, @Query() query: Q) { return this.drafts.list(actorOf(req).companyId, query); }

  @Permissions('create_financeiro') @Post('statement-drafts')
  createDraft(@Req() req: Request, @Body() body: Q) {
    const source = ['pdf', 'mcp'].includes(String(body?.source)) ? String(body?.source) : 'pdf';
    return this.drafts.create(actorOf(req), body ?? {}, { source, botId: Number(body?.botId) || null });
  }

  @Permissions('list_financeiro') @Get('statement-drafts/:id')
  getDraft(@Req() req: Request, @Param('id', ParseIntPipe) id: number) { return this.drafts.view(actorOf(req).companyId, id); }

  @Permissions('update_financeiro') @Put('statement-drafts/:id/suggestions')
  suggestDraft(@Req() req: Request, @Param('id', ParseIntPipe) id: number, @Body() body: Q) { return this.drafts.suggest(actorOf(req), id, body ?? {}); }

  @Permissions('update_financeiro') @Post('statement-drafts/:id/apply')
  applyDraft(@Req() req: Request, @Param('id', ParseIntPipe) id: number, @Body() body: Q) { return this.drafts.apply(actorOf(req), id, body ?? {}); }

  @Permissions('update_financeiro') @Patch('statement-drafts/:id/discard')
  discardDraft(@Req() req: Request, @Param('id', ParseIntPipe) id: number) { return this.drafts.discard(actorOf(req), id); }
}

/** OFX de banco brasileiro costuma vir em latin1; UTF-8 quando o cabeçalho diz. */
function decodeOfx(buffer: Buffer): string {
  const head = buffer.subarray(0, 400).toString('latin1');
  return /CHARSET:\s*(UTF-?8|65001)|encoding="utf-8"/i.test(head) ? buffer.toString('utf8') : buffer.toString('latin1');
}
