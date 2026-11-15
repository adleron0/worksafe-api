import { Body, Controller, Get, HttpCode, Post, Put, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { MarketingService } from './marketing.service';

const companyOf = (req: Request) =>
  Number((req as Request & { user?: { companyId?: number } }).user?.companyId ?? 0);

/** Divulgação de turmas: configurações e variação de legenda com IA. */
@Controller('marketing')
export class MarketingController {
  constructor(private readonly marketing: MarketingService) {}

  @Permissions('list_divulgacao') @Get('settings')
  settings(@Req() req: Request) { return this.marketing.getSettings(companyOf(req)); }

  @Permissions('update_divulgacao') @Put('settings')
  update(@Req() req: Request, @Body() body: Record<string, unknown>) { return this.marketing.updateSettings(companyOf(req), body ?? {}); }

  @Permissions('update_divulgacao') @Post('captions/restore-defaults') @HttpCode(200)
  restore(@Req() req: Request) { return this.marketing.restoreDefaultCaptions(companyOf(req)); }

  @Permissions('list_divulgacao') @Post('captions/ai') @HttpCode(200)
  rewrite(@Body() body: Record<string, unknown>) { return this.marketing.rewriteCaption(body ?? {}); }
}
