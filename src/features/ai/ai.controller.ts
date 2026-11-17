import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Req, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import { Request } from 'express';
import * as multer from 'multer';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { extractUserPermissions } from 'src/auth/utils/check-permission.util';
import { PrismaService } from 'src/prisma/prisma.service';
import { BotActor, BotService } from './bots/bot.service';
import { AgentService, UploadedImage, botsEnabled } from './engine/agent.service';
import { UsageService } from './engine/usage.service';
import { ProviderRegistry } from './providers/provider.registry';
import { ToolCatalogService } from './tools/tool-catalog.service';

export const actorOf = (req: Request): BotActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0), permissions: extractUserPermissions(user) };
};
type Json = Record<string, unknown>;
const UPLOAD = { storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 3 } };

/** Área de Bots: bots, conversas, execuções, ações pendentes, auditoria e gasto. */
@Controller('ai')
export class AiController {
  constructor(
    private readonly bots: BotService,
    private readonly agent: AgentService,
    private readonly catalog: ToolCatalogService,
    private readonly usage: UsageService,
    private readonly providers: ProviderRegistry,
    private readonly prisma: PrismaService,
  ) {}

  /** Para o menu e a tela: ligado?, fornecedores com chave e o gasto do mês (este só para quem audita). */
  @Get('status')
  async status(@Req() req: Request) {
    const actor = actorOf(req);
    const audits = actor.permissions.includes('view_auditoria_bots') || actor.permissions.includes('update_bots');
    return {
      enabled: botsEnabled(),
      mcpEnabled: process.env.MCP_ENABLED !== 'false',
      providers: this.providers.status(),
      usage: audits ? await this.usage.summary(actor.companyId) : null,
      pendingActions: (await this.catalog.pending(actor)).length,
    };
  }

  // ---------------------------------------------------------------- bots

  @Permissions('usar_bots') @Get('bots')
  list(@Req() req: Request) { return this.bots.listFor(actorOf(req)); }

  @Permissions('usar_bots') @Get('team')
  team(@Req() req: Request) { return this.agent.team(actorOf(req)); }

  @Permissions('usar_bots') @Get('team/:botId/activity')
  botActivity(@Req() req: Request, @Param('botId', ParseIntPipe) botId: number, @Query('dias') dias?: string) {
    return this.agent.botActivity(actorOf(req), botId, Number(dias) || 1);
  }

  @Permissions('update_bots') @Get('bots/config')
  config(@Req() req: Request) { return this.bots.listAll(actorOf(req)); }

  @Permissions('update_bots') @Put('bots/:id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.bots.update(actorOf(req), id, body ?? {}); }

  @Permissions('update_bots') @Get('bots/:id/versions')
  versions(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.bots.versions(actorOf(req), id); }

  @Permissions('update_bots') @Post('bots/:id/versions/:version/restore') @HttpCode(200)
  restore(@Param('id', ParseIntPipe) id: number, @Param('version', ParseIntPipe) version: number, @Req() req: Request) { return this.bots.restore(actorOf(req), id, version); }

  @Permissions('update_bots') @Post('bots/:id/reset') @HttpCode(200)
  reset(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.bots.reset(actorOf(req), id); }

  // ---------------------------------------------------------------- conversas

  @Permissions('usar_bots') @Get('bots/:id/conversations')
  conversations(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.agent.conversations(actorOf(req), id); }

  @Permissions('usar_bots') @Post('bots/:id/conversations')
  createConversation(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.agent.createConversation(actorOf(req), id); }

  @Permissions('usar_bots') @Get('conversations/:id')
  conversation(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.agent.conversation(actorOf(req), id); }

  @Permissions('usar_bots') @Put('conversations/:id')
  rename(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.agent.rename(actorOf(req), id, body?.title); }

  @Permissions('usar_bots') @Patch('conversations/:id/archive')
  archive(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.agent.archive(actorOf(req), id); }

  @Permissions('usar_bots') @Post('conversations/:id/messages')
  @UseInterceptors(FilesInterceptor('files', 3, UPLOAD))
  send(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json, @UploadedFiles() files?: UploadedImage[]) {
    return this.agent.send(actorOf(req), id, body?.text, files ?? []);
  }

  @Permissions('usar_bots') @Get('runs/:id')
  run(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.agent.run(actorOf(req), id); }

  @Permissions('usar_bots') @Patch('runs/:id/stop')
  stop(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.agent.stop(actorOf(req), id); }

  // ---------------------------------------------------------------- ações pendentes

  private assertCanAct(req: Request) {
    const actor = actorOf(req);
    if (!actor.permissions.includes('usar_bots') && !actor.permissions.includes('usar_mcp')) throw new ForbiddenException('Acesso negado: Permissões insuficientes');
    return actor;
  }

  @Get('actions')
  actions(@Req() req: Request) { return this.catalog.pending(this.assertCanAct(req)); }

  @Post('actions/:id/confirm') @HttpCode(200)
  async confirm(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const actor = this.assertCanAct(req);
    const out = await this.catalog.confirm(actor, id);
    const text = out.result ? `Ação confirmada: ${out.result.message}` : `A ação não foi feita: ${out.action.error}`;
    await this.agent.afterAction(actor, out.action.conversationId, text);
    return { ...out.action, message: out.result?.message ?? null, link: out.result?.link ?? null };
  }

  @Post('actions/:id/cancel') @HttpCode(200)
  async cancel(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const actor = this.assertCanAct(req);
    const action = await this.catalog.cancel(actor, id);
    await this.agent.afterAction(actor, action.conversationId, `A pessoa cancelou a ação: ${action.summary}`);
    return action;
  }

  // ---------------------------------------------------------------- auditoria e gasto

  @Permissions('view_auditoria_bots') @Get('audit')
  async audit(@Req() req: Request, @Query() query: Record<string, string>) {
    const actor = actorOf(req);
    const page = Math.max(0, Number(query.page) || 0);
    const where: Prisma.Ai_ToolCallWhereInput = {
      companyId: actor.companyId,
      ...(query.origin ? { origin: query.origin } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(Number(query.userId) > 0 ? { userId: Number(query.userId) } : {}),
      ...(query.tool ? { tool: query.tool } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.ai_ToolCall.findMany({ where, orderBy: { id: 'desc' }, skip: page * 50, take: 50 }),
      this.prisma.ai_ToolCall.count({ where }),
    ]);
    const [users, bots] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.userId))] } }, select: { id: true, name: true } }),
      this.prisma.ai_Bot.findMany({ where: { companyId: actor.companyId }, select: { id: true, name: true } }),
    ]);
    const userName = new Map(users.map((user) => [user.id, user.name]));
    const botName = new Map(bots.map((bot) => [bot.id, bot.name]));
    return {
      total,
      rows: rows.map((row) => ({
        id: row.id, createdAt: row.createdAt, user: userName.get(row.userId) ?? `#${row.userId}`, origin: row.origin, bot: row.botId ? botName.get(row.botId) ?? null : null,
        tool: row.tool, title: this.catalog.get(row.tool)?.title ?? row.tool, status: row.status, input: row.input, outputSummary: row.outputSummary, durationMs: row.durationMs,
      })),
    };
  }

  @Permissions('view_auditoria_bots') @Get('usage')
  usageSummary(@Req() req: Request, @Query('month') month?: string) {
    return this.usage.summary(actorOf(req).companyId, /^\d{4}-\d{2}$/.test(month ?? '') ? month : undefined);
  }
}
