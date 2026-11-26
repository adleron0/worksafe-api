import { Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { Public } from 'src/auth/decorators/public.decorator';
import { extractUserPermissions } from 'src/auth/utils/check-permission.util';
import { clientIpOf } from 'src/common/security/client-ip';
import { ChatActor, ChatChannelsService } from './chat-channels.service';
import { ChatConversationsService } from './chat-conversations.service';
import { ChatInboundService } from './chat-inbound.service';
import { ChatEventsService } from './chat-events.service';
import { ChatCustomerService } from './chat-customer.service';
import { ChatLibraryService } from './chat-library.service';
import { ChatActionsService } from './chat-actions.service';
import { ChatBotService } from './chat-bot.service';
import { MAX_OUT } from './chat-media.service';
import { ChatMetricsService } from './chat-metrics.service';
import { ChatCloudService } from './chat-cloud.service';
import { ChatTranscribeService } from './chat-transcribe.service';

type Json = Record<string, any>;

const actorOf = (req: Request): ChatActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0), permissions: extractUserPermissions(user) };
};

/** Conversas: números de WhatsApp, caixa de entrada e webhook do Evolution. */
@Controller('chat')
export class ChatController {
  constructor(
    private readonly channels: ChatChannelsService,
    private readonly metricsService: ChatMetricsService,
    private readonly cloud: ChatCloudService,
    private readonly transcriber: ChatTranscribeService,
    private readonly conversations: ChatConversationsService,
    private readonly inbound: ChatInboundService,
    private readonly events: ChatEventsService,
    private readonly customerSearch: ChatCustomerService,
    private readonly library: ChatLibraryService,
    private readonly actions: ChatActionsService,
    private readonly bots: ChatBotService,
  ) {}

  private seeing(req: Request) {
    const actor = actorOf(req);
    if (!['view_conversas', 'todas_conversas', 'canais_conversas'].some((p) => actor.permissions.includes(p))) throw new ForbiddenException('Acesso negado: Permissões insuficientes');
    return actor;
  }

  // ---------------------------------------------------------------- tempo real

  /** Ticket de uso único para abrir o fluxo de eventos (o EventSource não manda o login). */
  @Post('stream/ticket') @HttpCode(200)
  ticket(@Req() req: Request) { return this.events.ticket(this.seeing(req)); }

  @Public() @SkipThrottle() @Get('stream')
  async stream(@Query('ticket') ticket: string, @Res() res: Response) {
    const actor = await this.events.redeem(ticket);
    if (!actor) {
      res.status(401).json({ statusCode: 401, message: 'Ticket inválido ou vencido' });
      return;
    }
    await this.events.open(actor, res);
  }

  @Get('meta')
  meta(@Req() req: Request) { return this.channels.meta(this.seeing(req).companyId); }

  // ---------------------------------------------------------------- números (canais)

  @Get('channels')
  channelsList(@Req() req: Request) { return this.channels.list(this.seeing(req)); }

  @Get('channels/:id/health')
  channelHealth(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.metricsService.health(actorOf(req), id); }

  @Get('metrics')
  metrics(@Query() query: Record<string, string>, @Req() req: Request) { return this.metricsService.metrics(actorOf(req), query); }

  @Permissions('canais_conversas') @Get('channels/:id')
  channel(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.channels.get(actorOf(req), id); }

  @Permissions('canais_conversas') @Post('channels')
  create(@Req() req: Request, @Body() body: Json) { return this.channels.create(actorOf(req), body ?? {}); }

  @Permissions('canais_conversas') @Put('channels/:id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.channels.update(actorOf(req), id, body ?? {}); }

  @Permissions('canais_conversas') @Delete('channels/:id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.channels.remove(actorOf(req), id); }

  @Permissions('canais_conversas') @Post('channels/:id/connect') @HttpCode(200)
  connect(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.channels.connect(actorOf(req), id, body ?? {}, clientIpOf(req)); }

  /** WhatsApp oficial (Cloud API): credenciais da Meta e dados do webhook. */
  @Permissions('canais_conversas') @Post('channels/:id/cloud') @HttpCode(200)
  connectCloud(@Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>, @Req() req: Request) { return this.cloud.connect(actorOf(req), id, body ?? {}); }

  @Permissions('canais_conversas') @Get('channels/:id/cloud')
  cloudInfo(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.cloud.webhookInfo(actorOf(req), id); }

  @Permissions('canais_conversas') @Get('channels/:id/qr')
  qr(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.channels.qr(actorOf(req), id); }

  @Permissions('canais_conversas') @Post('channels/:id/disconnect') @HttpCode(200)
  disconnect(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.channels.disconnect(actorOf(req), id); }

  @Permissions('canais_conversas') @Get('channels/:id/hidden')
  hiddenList(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.channels.hiddenList(actorOf(req), id); }

  @Permissions('canais_conversas') @Post('channels/:id/hidden') @HttpCode(200)
  hidePhone(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.channels.hidePhone(actorOf(req), id, body ?? {}); }

  @Permissions('canais_conversas') @Delete('channels/:id/hidden/:contactId')
  unhide(@Param('id', ParseIntPipe) id: number, @Param('contactId', ParseIntPipe) contactId: number, @Req() req: Request) { return this.channels.unhide(actorOf(req), id, contactId); }

  // ---------------------------------------------------------------- caixa de entrada

  @Get('conversations')
  list(@Req() req: Request, @Query() query: Record<string, string>) { return this.conversations.list(this.seeing(req), query); }

  @Get('unread')
  unread(@Req() req: Request) { return this.conversations.unread(this.seeing(req)); }

  @Post('conversations') @HttpCode(200)
  start(@Req() req: Request, @Body() body: Json) { return this.conversations.start(this.seeing(req), body ?? {}); }

  @Get('conversations/:id')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Query('before') before?: string) {
    return this.conversations.get(this.seeing(req), id, before ? Number(before) : undefined);
  }

  @Patch('conversations/:id')
  patch(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.conversations.update(this.seeing(req), id, body ?? {}); }

  @Post('conversations/:id/messages') @HttpCode(200)
  send(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.conversations.sendText(this.seeing(req), id, body ?? {}); }

  @Post('conversations/:id/media') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_OUT + 1024, files: 1 } }))
  media(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @UploadedFile() file: Express.Multer.File, @Body() body: Json) {
    return this.conversations.sendMedia(this.seeing(req), id, file, body ?? {});
  }

  @Post('conversations/:id/notes') @HttpCode(200)
  note(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.conversations.note(this.seeing(req), id, body ?? {}); }

  @Post('conversations/:id/messages/:messageId/retry') @HttpCode(200)
  retry(@Param('id', ParseIntPipe) id: number, @Param('messageId', ParseIntPipe) messageId: number, @Req() req: Request) {
    return this.conversations.retry(this.seeing(req), id, messageId);
  }

  @Post('conversations/:id/messages/:messageId/transcribe') @HttpCode(200)
  async transcribe(@Param('id', ParseIntPipe) id: number, @Param('messageId', ParseIntPipe) messageId: number, @Req() req: Request) {
    return this.transcriber.request(await this.conversations.messageOf(this.seeing(req), id, messageId));
  }

  @Post('conversations/:id/messages/:messageId/media') @HttpCode(200)
  retryMedia(@Param('id', ParseIntPipe) id: number, @Param('messageId', ParseIntPipe) messageId: number, @Req() req: Request) {
    return this.conversations.retryMedia(this.seeing(req), id, messageId);
  }

  // ---------------------------------------------------------------- respostas rápidas e etiquetas

  @Get('quick-replies')
  replies(@Req() req: Request) { return this.library.replies(this.seeing(req)); }

  @Post('quick-replies')
  createReply(@Req() req: Request, @Body() body: Json) { return this.library.createReply(this.seeing(req), body ?? {}); }

  @Put('quick-replies/:id')
  updateReply(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.library.updateReply(this.seeing(req), id, body ?? {}); }

  @Delete('quick-replies/:id')
  removeReply(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.library.removeReply(this.seeing(req), id); }

  @Post('quick-replies/:id/used') @HttpCode(200)
  usedReply(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.library.used(this.seeing(req), id); }

  @Get('tags')
  tags(@Req() req: Request) { return this.library.tags(this.seeing(req)); }

  @Post('tags')
  createTag(@Req() req: Request, @Body() body: Json) { return this.library.createTag(this.seeing(req), body ?? {}); }

  @Put('tags/:id')
  updateTag(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.library.updateTag(this.seeing(req), id, body ?? {}); }

  @Delete('tags/:id')
  removeTag(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.library.removeTag(this.seeing(req), id); }

  @Put('conversations/:id/tags')
  setTags(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.conversations.setTags(this.seeing(req), id, body?.tagIds); }

  @Patch('conversations/:id/contact')
  contact(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.conversations.updateContact(this.seeing(req), id, body ?? {}); }

  @Get('conversations/:id/customer')
  customer(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.conversations.customerSummary(this.seeing(req), id); }

  @Get('customers')
  customers(@Req() req: Request, @Query('search') search?: string) { return this.customerSearch.search(this.seeing(req), search ?? ''); }

  @Post('conversations/:id/hide') @HttpCode(200)
  hide(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.conversations.hide(this.seeing(req), id); }

  // ---------------------------------------------------------------- bots

  /** Pedir agora um rascunho de resposta ao bot. */
  @Post('conversations/:id/suggestion')
  async askSuggestion(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) {
    const actor = this.seeing(req);
    return this.bots.ask(actor, await this.conversations.loadFor(actor, id), body?.botId);
  }

  @Post('conversations/:id/suggestion/:suggestionId/discard') @HttpCode(200)
  async discardSuggestion(@Param('id', ParseIntPipe) id: number, @Param('suggestionId', ParseIntPipe) suggestionId: number, @Req() req: Request) {
    const actor = this.seeing(req);
    await this.conversations.loadFor(actor, id);
    return this.bots.discard(actor, id, suggestionId);
  }

  /** Passar a conversa para um bot (ele atende só nela). */
  @Post('conversations/:id/bot') @HttpCode(200)
  async handToBot(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) {
    const actor = this.seeing(req);
    return this.bots.handTo(actor, await this.conversations.loadFor(actor, id), body?.botId);
  }

  /** Retomar do bot. */
  @Delete('conversations/:id/bot')
  async takeBack(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const actor = this.seeing(req);
    return this.bots.takeBack(actor, await this.conversations.loadFor(actor, id));
  }

  // ---------------------------------------------------------------- ações comerciais

  /** Negociação ligada, as do cliente e os retornos/contatos desta conversa. */
  @Get('conversations/:id/commercial')
  async commercial(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const actor = this.seeing(req);
    const conversation = await this.conversations.loadFor(actor, id);
    const [deals, activities] = await Promise.all([this.actions.dealsOf(actor, conversation), this.actions.activitiesOf(actor, conversation)]);
    return { deals, activities };
  }

  @Get('conversations/:id/links')
  async links(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const actor = this.seeing(req);
    return this.actions.links(actor, await this.conversations.loadFor(actor, id));
  }

  @Post('conversations/:id/activity')
  async registerContact(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) {
    const actor = this.seeing(req);
    return this.actions.registerContact(actor, await this.conversations.loadFor(actor, id), body ?? {});
  }

  @Post('conversations/:id/return')
  async scheduleReturn(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) {
    const actor = this.seeing(req);
    return this.actions.scheduleReturn(actor, await this.conversations.loadFor(actor, id), body ?? {});
  }

  @Post('conversations/:id/deal')
  async createDeal(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) {
    const actor = this.seeing(req);
    return this.actions.createDeal(actor, await this.conversations.loadFor(actor, id), body ?? {});
  }

  @Put('conversations/:id/deal')
  async linkDeal(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) {
    const actor = this.seeing(req);
    return this.actions.linkDeal(actor, await this.conversations.loadFor(actor, id), body?.dealId ?? null);
  }

  @Post('conversations/:id/read') @HttpCode(200)
  read(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.conversations.read(this.seeing(req), id); }

  // ---------------------------------------------------------------- webhook do Evolution

  /** Cada número tem seu endereço e um segredo no cabeçalho (gravado como hash). */
  @Public() @SkipThrottle() @Post('webhook/evolution/:channelId') @HttpCode(200)
  async webhook(@Param('channelId', ParseIntPipe) channelId: number, @Headers('x-ws-chat-secret') secret: string, @Body() body: Json) {
    const channel = await this.channels.channelForWebhook(channelId, secret);
    if (!channel) throw new ForbiddenException('Webhook inválido');
    return { ok: true, ...(await this.inbound.handle(channel, body ?? {})) };
  }

  /** Webhook do WhatsApp oficial: verificação (GET) e eventos (POST, corpo bruto para a assinatura). */
  @Public() @SkipThrottle() @Get('webhook/cloud/:channelId')
  async cloudVerify(@Param('channelId', ParseIntPipe) channelId: number, @Query() query: Json, @Res() res: Response) {
    res.status(200).type('text/plain').send(await this.cloud.verify(channelId, query));
  }

  @Public() @SkipThrottle() @Post('webhook/cloud/:channelId') @HttpCode(200)
  async cloudWebhook(@Param('channelId', ParseIntPipe) channelId: number, @Req() req: Request) {
    const raw = Buffer.isBuffer(req.body) ? req.body : undefined;
    return { ok: true, ...(await this.cloud.receive(channelId, raw, req.headers['x-hub-signature-256'])) };
  }
}
