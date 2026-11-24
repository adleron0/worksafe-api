import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import * as multer from 'multer';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { Public } from 'src/auth/decorators/public.decorator';
import { actorOf } from '../ai.controller';
import { InstagramService } from './instagram.service';
import { InstagramMessagesService } from './instagram-messages.service';

type Json = Record<string, unknown>;

/** Bots → Conectores: contas externas da empresa (hoje, o Instagram) e os posts agendados. */
@Controller('ai')
export class ConnectorsController {
  constructor(private readonly instagram: InstagramService, private readonly messages: InstagramMessagesService) {}

  private seeing(req: Request) {
    const actor = actorOf(req);
    if (!actor.permissions.includes('conectores_bots') && !actor.permissions.includes('instagram_bots')) throw new ForbiddenException('Acesso negado: Permissões insuficientes');
    return actor;
  }

  @Get('connectors')
  async list(@Req() req: Request) {
    const actor = this.seeing(req);
    return { instagram: await this.instagram.status(actor.companyId) };
  }

  @Permissions('conectores_bots') @Post('connectors/instagram/start') @HttpCode(200)
  start(@Req() req: Request) { return this.instagram.startUrl(actorOf(req)); }

  /** Volta da tela de permissão da Meta (sem login: quem a pessoa é vem no state assinado). */
  @Public() @Get('connectors/instagram/callback')
  async callback(@Query() query: Json, @Res() res: Response) {
    res.redirect(302, await this.instagram.callback(query));
  }

  @Permissions('conectores_bots') @Delete('connectors/instagram')
  disconnect(@Req() req: Request) { return this.instagram.disconnect(actorOf(req).companyId); }

  // ---------------------------------------------------------------- posts

  @Permissions('instagram_bots') @Get('instagram/posts')
  posts(@Req() req: Request, @Query('status') status?: string) { return this.instagram.list(actorOf(req).companyId, { status }); }

  @Permissions('instagram_bots') @Post('instagram/posts')
  create(@Req() req: Request, @Body() body: Json) { return this.instagram.create(actorOf(req), body ?? {}); }

  @Permissions('instagram_bots') @Post('instagram/upload')
  @UseInterceptors(FileInterceptor('file', { storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }))
  upload(@UploadedFile() file?: { buffer: Buffer }) { return this.instagram.upload(file?.buffer as Buffer); }

  @Permissions('instagram_bots') @Post('instagram/posts/:id/publish') @HttpCode(200)
  publish(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.instagram.publishNow(actorOf(req).companyId, id); }

  @Permissions('instagram_bots') @Patch('instagram/posts/:id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.instagram.cancel(actorOf(req).companyId, id); }

  // ---------------------------------------------------------------- configurações

  @Permissions('conectores_bots') @Get('connectors/instagram/settings')
  getSettings(@Req() req: Request) { return this.instagram.settings(actorOf(req).companyId); }

  @Permissions('conectores_bots') @Put('connectors/instagram/settings')
  putSettings(@Req() req: Request, @Body() body: unknown) { return this.instagram.saveSettings(actorOf(req).companyId, body); }

  // ---------------------------------------------------------------- webhook da Meta

  /** Verificação do endereço (a Meta manda hub.challenge e espera o mesmo texto de volta). */
  @Public() @SkipThrottle() @Get('connectors/instagram/webhook')
  verify(@Query() query: Json, @Res() res: Response) {
    res.status(200).type('text/plain').send(this.messages.challenge(query));
  }

  /**
   * Mensagens e comentários. O corpo chega bruto (Buffer, ver
   * mountInstagramWebhookBody) para conferir a assinatura da Meta.
   */
  @Public() @SkipThrottle() @Post('connectors/instagram/webhook') @HttpCode(200)
  async webhook(@Req() req: Request) {
    const raw = Buffer.isBuffer(req.body) ? req.body : undefined;
    if (!this.messages.validSignature(raw, req.headers['x-hub-signature-256'])) throw new ForbiddenException('Assinatura inválida');
    let body: unknown;
    try { body = JSON.parse(raw!.toString('utf8')); } catch { return { ok: true, stored: 0 }; }
    const out = await this.messages.receive(body);
    return { ok: true, ...out };
  }

  // ---------------------------------------------------------------- Direct

  @Permissions('instagram_mensagens_bots') @Get('instagram/conversations')
  conversations(@Req() req: Request, @Query('sync') sync?: string) {
    return this.messages.conversations(actorOf(req).companyId, { sync: sync === '1' || sync === 'true' });
  }

  @Permissions('instagram_mensagens_bots') @Get('instagram/conversations/:id')
  conversation(@Param('id') id: string, @Req() req: Request, @Query('sync') sync?: string) {
    return this.messages.conversation(actorOf(req).companyId, id, { sync: sync === '1' || sync === 'true' });
  }

  @Permissions('instagram_mensagens_bots') @Post('instagram/conversations/:id/read') @HttpCode(200)
  markRead(@Param('id') id: string, @Req() req: Request) { return this.messages.markRead(actorOf(req).companyId, id); }

  @Permissions('instagram_mensagens_bots') @Post('instagram/conversations/:id/reply') @HttpCode(200)
  reply(@Param('id') id: string, @Req() req: Request, @Body() body: Json) {
    const actor = actorOf(req);
    return this.messages.reply({ companyId: actor.companyId, userId: actor.userId }, id, body?.text);
  }

  // ---------------------------------------------------------------- comentários

  @Permissions('instagram_mensagens_bots') @Get('instagram/comments')
  comments(@Req() req: Request, @Query('mediaId') mediaId?: string) {
    return this.messages.comments(actorOf(req).companyId, { mediaId: mediaId || undefined });
  }

  @Permissions('instagram_mensagens_bots') @Post('instagram/comments/:id/reply') @HttpCode(200)
  replyComment(@Param('id') id: string, @Req() req: Request, @Body() body: Json) {
    const actor = actorOf(req);
    return this.messages.replyComment({ companyId: actor.companyId, userId: actor.userId }, id, body?.text);
  }

  @Permissions('instagram_mensagens_bots') @Post('instagram/comments/:id/hide') @HttpCode(200)
  hideComment(@Param('id') id: string, @Req() req: Request, @Body() body: Json) {
    return this.messages.hideComment(actorOf(req).companyId, id, body?.hide !== false);
  }
}
