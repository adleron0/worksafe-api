import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Ai_Bot, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { PROVIDER_LABELS, ProviderRegistry } from '../providers/provider.registry';
import { ToolCatalogService } from '../tools/tool-catalog.service';
import { BOT_DEFAULTS, defaultModelFor } from './bot.defaults';

export interface BotActor { userId: number; companyId: number; permissions: string[] }

const clean = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max);

/** Configuração dos bots por empresa: nasce dos padrões e o super ajusta. */
@Injectable()
export class BotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: ToolCatalogService,
    private readonly providers: ProviderRegistry,
  ) {}

  /** Cria os bots padrão que ainda não existem na empresa (idempotente). */
  async ensureDefaults(companyId: number): Promise<void> {
    const existing = await this.prisma.ai_Bot.findMany({ where: { companyId }, select: { key: true } });
    const have = new Set(existing.map((bot) => bot.key));
    for (const bot of BOT_DEFAULTS) {
      if (have.has(bot.key)) continue;
      const { provider, model } = defaultModelFor(bot);
      await this.prisma.ai_Bot.create({
        data: {
          companyId, key: bot.key, name: bot.name, description: bot.description, icon: bot.icon, instructions: bot.instructions,
          tools: bot.tools, provider, model, permissionKey: `usar_bot_${bot.key}`, shortcuts: bot.shortcuts,
          versions: { create: { version: 1, instructions: bot.instructions, tools: bot.tools, provider, model } },
        },
      }).catch((error) => {
        // dois acessos ao mesmo tempo: o outro criou primeiro
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      });
    }
  }

  /** Bots que a pessoa pode usar. */
  async listFor(actor: BotActor) {
    await this.ensureDefaults(actor.companyId);
    const bots = await this.prisma.ai_Bot.findMany({ where: { companyId: actor.companyId, inactiveAt: null, active: true }, orderBy: { id: 'asc' } });
    return bots.filter((bot) => actor.permissions.includes(bot.permissionKey)).map((bot) => this.present(bot, actor.permissions, false));
  }

  /** Todos, para a tela de configuração. */
  async listAll(actor: BotActor) {
    await this.ensureDefaults(actor.companyId);
    const bots = await this.prisma.ai_Bot.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { id: 'asc' } });
    return {
      bots: bots.map((bot) => this.present(bot, actor.permissions, true)),
      providers: this.providers.status(),
      tools: this.catalog.all().map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, risk: tool.risk, permissions: [...tool.permissions, ...(tool.anyPermissions?.length ? [`uma de: ${tool.anyPermissions.join(', ')}`] : [])] })),
      enabled: process.env.AI_BOTS_ENABLED !== 'false',
    };
  }

  async usable(actor: BotActor, botId: number): Promise<Ai_Bot> {
    const bot = await this.prisma.ai_Bot.findFirst({ where: { id: botId, companyId: actor.companyId, inactiveAt: null } });
    if (!bot) throw new NotFoundException('Bot não encontrado');
    if (!bot.active) throw new ForbiddenException('Este bot está desligado');
    if (!actor.permissions.includes(bot.permissionKey)) throw new ForbiddenException('Você não tem acesso a este bot');
    return bot;
  }

  present(bot: Ai_Bot, permissions: string[], full: boolean) {
    const names = (bot.tools as string[]) ?? [];
    const visible = this.catalog.visible(names, permissions);
    const base = {
      id: bot.id, key: bot.key, name: bot.name, description: bot.description, icon: bot.icon, active: bot.active,
      shortcuts: (bot.shortcuts as { label: string; prompt: string }[] | null) ?? [],
      provider: bot.provider, providerLabel: PROVIDER_LABELS[bot.provider] ?? bot.provider, model: bot.model,
      providerReady: !!this.providers.get(bot.provider)?.available(),
      // o que esta pessoa pode fazer com o bot (as outras ferramentas ficam escondidas)
      capabilities: visible.map((tool) => ({ name: tool.name, title: tool.title, risk: tool.risk })),
      hiddenCount: names.length - visible.length,
    };
    if (!full) return base;
    return {
      ...base, instructions: bot.instructions, tools: names, permissionKey: bot.permissionKey, version: bot.version,
      fallbackProvider: bot.fallbackProvider, fallbackModel: bot.fallbackModel, updatedAt: bot.updatedAt,
    };
  }

  async update(actor: BotActor, botId: number, body: Record<string, unknown>) {
    const bot = await this.prisma.ai_Bot.findFirst({ where: { id: botId, companyId: actor.companyId, inactiveAt: null } });
    if (!bot) throw new NotFoundException('Bot não encontrado');
    const data: Prisma.Ai_BotUpdateInput = {};
    if ('name' in body) {
      const name = clean(body.name, 80);
      if (name.length < 2) throw new BadRequestException('Informe o nome do bot');
      data.name = name;
    }
    if ('description' in body) data.description = clean(body.description, 300);
    if ('active' in body) data.active = body.active === true || body.active === 'true';
    if ('shortcuts' in body) {
      if (!Array.isArray(body.shortcuts)) throw new BadRequestException('Atalhos inválidos');
      data.shortcuts = body.shortcuts.slice(0, 8).map((item: any) => ({ label: clean(item?.label, 40), prompt: clean(item?.prompt, 500) })).filter((item) => item.label && item.prompt);
    }
    let versioned = false;
    if ('instructions' in body) {
      const instructions = clean(body.instructions, 20000);
      if (instructions.length < 20) throw new BadRequestException('As instruções estão curtas demais');
      if (instructions !== bot.instructions) { data.instructions = instructions; versioned = true; }
    }
    if ('tools' in body) {
      if (!Array.isArray(body.tools)) throw new BadRequestException('Ferramentas inválidas');
      const tools = [...new Set(body.tools.map(String))];
      const unknown = tools.filter((name) => !this.catalog.get(name));
      if (unknown.length) throw new BadRequestException(`Ferramentas desconhecidas: ${unknown.join(', ')}`);
      data.tools = tools;
      versioned = true;
    }
    for (const [field, providerField] of [['model', 'provider'], ['fallbackModel', 'fallbackProvider']] as const) {
      if (!(providerField in body) && !(field in body)) continue;
      const provider = clean(body[providerField], 20);
      const model = clean(body[field], 80);
      if (field === 'fallbackModel' && !provider && !model) { data.fallbackProvider = null; data.fallbackModel = null; continue; }
      if (!PROVIDER_LABELS[provider] && !(provider === 'fake' && process.env.NODE_ENV === 'test')) throw new BadRequestException('Fornecedor de IA inválido');
      if (model.length < 3) throw new BadRequestException('Informe o modelo');
      if (field === 'model') { data.provider = provider; data.model = model; versioned = true; } else { data.fallbackProvider = provider; data.fallbackModel = model; }
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.ai_Bot.update({ where: { id: bot.id }, data: { ...data, ...(versioned ? { version: { increment: 1 } } : {}) } });
      if (versioned) {
        await tx.ai_BotVersion.create({ data: { botId: row.id, version: row.version, instructions: row.instructions, tools: row.tools as Prisma.InputJsonValue, provider: row.provider, model: row.model, userId: actor.userId || null } });
      }
      return row;
    });
    return this.present(updated, actor.permissions, true);
  }

  async versions(actor: BotActor, botId: number) {
    const bot = await this.prisma.ai_Bot.findFirst({ where: { id: botId, companyId: actor.companyId }, select: { id: true } });
    if (!bot) throw new NotFoundException('Bot não encontrado');
    const rows = await this.prisma.ai_BotVersion.findMany({ where: { botId }, orderBy: { version: 'desc' }, take: 50 });
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((row) => row.userId).filter((id): id is number => !!id) } }, select: { id: true, name: true } });
    const name = new Map(users.map((user) => [user.id, user.name]));
    return rows.map((row) => ({ version: row.version, instructions: row.instructions, tools: row.tools, provider: row.provider, model: row.model, user: row.userId ? name.get(row.userId) ?? null : null, createdAt: row.createdAt }));
  }

  /** Volta as instruções, ferramentas e modelo para uma versão anterior (vira uma versão nova). */
  async restore(actor: BotActor, botId: number, version: number) {
    const row = await this.prisma.ai_BotVersion.findFirst({ where: { botId, version, bot: { companyId: actor.companyId } } });
    if (!row) throw new NotFoundException('Versão não encontrada');
    return this.update(actor, botId, { instructions: row.instructions, tools: row.tools, provider: row.provider, model: row.model });
  }

  /** Volta o bot para o padrão do sistema (instruções, ferramentas e atalhos). */
  async reset(actor: BotActor, botId: number) {
    const bot = await this.prisma.ai_Bot.findFirst({ where: { id: botId, companyId: actor.companyId } });
    if (!bot) throw new NotFoundException('Bot não encontrado');
    const preset = BOT_DEFAULTS.find((item) => item.key === bot.key);
    if (!preset) throw new BadRequestException('Este bot não tem padrão');
    return this.update(actor, botId, { instructions: preset.instructions, tools: preset.tools, shortcuts: preset.shortcuts, name: preset.name, description: preset.description });
  }
}
