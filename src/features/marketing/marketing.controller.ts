import { BadRequestException, Body, Controller, Get, HttpCode, Post, Put, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { getMulterOptions } from '../upload/upload.middleware';
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
  rewrite(@Req() req: Request, @Body() body: Record<string, unknown>) { return this.marketing.rewriteCaption(companyOf(req), body ?? {}); }

  /**
   * Logo, selo ou foto da identidade visual. Vai para o bucket público sem
   * otimização (logo precisa manter a transparência do PNG). Devolve a URL;
   * quem guarda é o PUT de settings.
   */
  @Permissions('update_divulgacao') @Post('upload') @HttpCode(200)
  @UseInterceptors(FileInterceptor('image', getMulterOptions('marketing')))
  upload(@UploadedFile() file?: Express.MulterS3.File) {
    if (!file?.location) throw new BadRequestException('Envie uma imagem (PNG, JPG ou WebP)');
    return { url: file.location };
  }
}
