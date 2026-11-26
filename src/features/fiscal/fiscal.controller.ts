import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { FiscalInvoiceService } from './invoice.service';
import { InvoiceOriginService } from './invoice.origin';
import { FiscalActor, FiscalSettingsService, ibsCbsSuggestionOf } from './settings.service';

type Json = Record<string, unknown>;
const actorOf = (req: Request): FiscalActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0) };
};
const sendFile = (res: Response, body: Buffer, fileName: string, type: string, download: boolean) => {
  res.set({
    'Content-Type': type, 'Content-Length': String(body.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  });
  res.end(body);
};

/** Área fiscal: configuração (certificado, série, serviços fiscais) e notas fiscais de serviço. */
@Controller('fiscal')
export class FiscalController {
  constructor(private readonly settings: FiscalSettingsService, private readonly invoices: FiscalInvoiceService, private readonly origins: InvoiceOriginService) {}

  // configuração
  @Permissions('view_nfse') @Get('settings')
  getSettings(@Req() req: Request) { return this.settings.get(actorOf(req).companyId); }

  @Permissions('config_fiscal') @Put('settings')
  updateSettings(@Req() req: Request, @Body() body: Json) { return this.settings.update(actorOf(req), body ?? {}); }

  @Permissions('config_fiscal') @Post('settings/certificate') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 60_000, files: 1 } }))
  certificate(@Req() req: Request, @UploadedFile() file: Express.Multer.File, @Body() body: Json) {
    return this.settings.saveCertificate(actorOf(req), file?.buffer, body?.password);
  }

  @Permissions('config_fiscal') @Delete('settings/certificate')
  removeCertificate(@Req() req: Request) { return this.settings.removeCertificate(actorOf(req)); }

  @Permissions('config_fiscal') @Post('settings/test') @HttpCode(200)
  test(@Req() req: Request) { return this.settings.testConnection(actorOf(req).companyId); }

  // tabelas oficiais
  @Permissions('view_nfse') @Get('catalog/services')
  nationalCodes(@Query('q') q: string) { return this.settings.searchNationalCodes(q); }

  @Permissions('view_nfse') @Get('catalog/ibscbs-suggestion')
  ibsCbsSuggestion(@Query('code') code: string) { return ibsCbsSuggestionOf(String(code ?? '').replace(/\D/g, '').padStart(6, '0')) ?? {}; }

  @Permissions('view_nfse') @Get('catalog/indop')
  indOp() { return this.settings.listIndOp(); }

  @Permissions('view_nfse') @Get('catalog/nbs')
  nbs(@Query('q') q: string) { return this.settings.searchNbs(q); }

  // serviços fiscais
  @Permissions('view_nfse') @Get('service-codes')
  serviceCodes(@Req() req: Request, @Query('all') all?: string) { return this.settings.listServiceCodes(actorOf(req).companyId, all === '1'); }

  @Permissions('config_fiscal') @Post('service-codes')
  createServiceCode(@Req() req: Request, @Body() body: Json) { return this.settings.createServiceCode(actorOf(req), body ?? {}); }

  @Permissions('config_fiscal') @Put('service-codes/:id')
  updateServiceCode(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.settings.updateServiceCode(actorOf(req), id, body ?? {}); }

  // notas
  @Permissions('view_nfse') @Get('invoices')
  list(@Req() req: Request, @Query() query: Json) { return this.invoices.list(actorOf(req).companyId, query ?? {}); }

  @Permissions('view_nfse') @Post('invoices/preview') @HttpCode(200)
  preview(@Req() req: Request, @Body() body: Json) { return this.invoices.preview(actorOf(req).companyId, body ?? {}); }

  @Permissions('emitir_nfse') @Get('invoices/from-origin')
  fromOrigin(@Req() req: Request, @Query() query: Json) { return this.origins.suggest(actorOf(req).companyId, query ?? {}); }

  @Permissions('view_nfse') @Get('training/pending')
  pendingTraining(@Req() req: Request) { return this.origins.pendingTraining(actorOf(req).companyId); }

  @Permissions('view_nfse') @Get('contracts/:id/summary')
  contractSummary(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.origins.contractSummary(actorOf(req).companyId, id); }

  @Permissions('emitir_nfse') @Post('invoices/external')
  external(@Req() req: Request, @Body() body: Json) { return this.invoices.registerExternal(actorOf(req), body ?? {}); }

  @Permissions('view_nfse') @Get('invoices/:id')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.invoices.get(actorOf(req).companyId, id); }

  @Permissions('emitir_nfse') @Post('invoices')
  create(@Req() req: Request, @Body() body: Json) { return this.invoices.create(actorOf(req), body ?? {}); }

  @Permissions('emitir_nfse') @Put('invoices/:id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.invoices.update(actorOf(req), id, body ?? {}); }

  @Permissions('emitir_nfse') @Delete('invoices/:id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.invoices.remove(actorOf(req), id); }

  @Permissions('emitir_nfse') @Post('invoices/:id/emit') @HttpCode(200)
  emit(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.invoices.emit(actorOf(req), id); }

  @Permissions('emitir_nfse') @Post('invoices/:id/check') @HttpCode(200)
  check(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.invoices.check(actorOf(req), id); }

  @Permissions('cancelar_nfse') @Post('invoices/:id/cancel') @HttpCode(200)
  cancel(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.invoices.cancel(actorOf(req), id, body ?? {}); }

  @Permissions('cancelar_nfse', 'emitir_nfse') @Post('invoices/:id/replace') @HttpCode(200)
  replace(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.invoices.startReplacement(actorOf(req), id); }

  @Permissions('emitir_nfse') @Post('invoices/:id/send') @HttpCode(200)
  send(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.invoices.send(actorOf(req), id, body ?? {}); }

  @Permissions('view_nfse') @Get('invoices/:id/pdf')
  async pdf(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Res() res: Response, @Query('download') download?: string) {
    const { body, fileName } = await this.invoices.pdf(actorOf(req).companyId, id);
    sendFile(res, body, fileName, 'application/pdf', download === '1');
  }

  @Permissions('view_nfse') @Get('invoices/:id/xml')
  async xml(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Res() res: Response) {
    const { body, fileName } = await this.invoices.xml(actorOf(req).companyId, id);
    sendFile(res, body, fileName, 'application/xml', true);
  }
}
