import { Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { Public } from 'src/auth/decorators/public.decorator';
import { extractUserPermissions } from 'src/auth/utils/check-permission.util';
import { clientIpOf } from 'src/common/security/client-ip';
import { ChatActor, ChatChannelsService } from './chat-channels.service';
import { ChatConversationsService } from './chat-conversations.service';
import { ChatInboundService } from './chat-inbound.service';

type Json = Record<string, any>;

const actorOf = (req: Request): ChatActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0), permissions: extractUserPermissions(user) };
};

/** Conversas: números de WhatsApp, caixa de entrada e webhook do Evolution. */
@Controller('chat')
export class ChatController {
  constructor(private readonly channels: ChatChannelsService, private readonly conversations: ChatConversationsService, private readonly inbound: ChatInboundService) {}

  private seeing(req: Request) {
    const actor = actorOf(req);
    if (!['view_conversas', 'todas_conversas', 'canais_conversas'].some((p) => actor.permissions.includes(p))) throw new ForbiddenException('Acesso negado: Permissões insuficientes');
    return actor;
  }

  @Get('meta')
  meta(@Req() req: Request) { return this.channels.meta(this.seeing(req).companyId); }

  // ---------------------------------------------------------------- números (canais)

  @Get('channels')
  channelsList(@Req() req: Request) { return this.channels.list(this.seeing(req)); }

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

  @Permissions('canais_conversas') @Get('channels/:id/qr')
  qr(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.channels.qr(actorOf(req), id); }

  @Permissions('canais_conversas') @Post('channels/:id/disconnect') @HttpCode(200)
  disconnect(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.channels.disconnect(actorOf(req), id); }

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

  @Post('conversations/:id/notes') @HttpCode(200)
  note(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.conversations.note(this.seeing(req), id, body ?? {}); }

  @Post('conversations/:id/messages/:messageId/retry') @HttpCode(200)
  retry(@Param('id', ParseIntPipe) id: number, @Param('messageId', ParseIntPipe) messageId: number, @Req() req: Request) {
    return this.conversations.retry(this.seeing(req), id, messageId);
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
}
