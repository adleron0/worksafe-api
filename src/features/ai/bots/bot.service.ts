import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Ai_Bot, Prisma } from '@prisma/client';
import { AuthCacheService } from 'src/common/cache/auth-cache.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PROVIDER_LABELS, ProviderRegistry } from '../providers/provider.registry';
import { ToolCatalogService } from '../tools/tool-catalog.service';
import { BOT_DEFAULTS, defaultModelFor } from './bot.defaults';
import { personalityCatalog } from './personality';

export interface BotActor { userId: number; companyId: number; permissions: string[] }

const clean = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max);

/** Chave de um modelo de rosto ("gestao") ou combinação do editor ("r:forma.cor.acessorio.olhos.jeito[.corDoAcessorio]"). */
const AVATAR_RE = /^(?:[a-z0-9_-]{2,40}|r:[a-z0-9_]{1,16}(?:\.[a-z0-9_]{1,16}){4,5})$/;
export const validAvatar = (value: unknown) => (AVATAR_RE.test(String(value ?? '')) ? String(value) : null);

/** "Ana Júlia" -> "ana_julia": vira a chave e a permissão (usar_bot_ana_julia). */
export const slugKey = (value: string) =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);

/** Configuração dos bots por empresa: nasce dos padrões e o super ajusta. */
@Injectable()
export class BotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: ToolCatalogService,
    private readonly providers: ProviderRegistry,
    private readonly authCache: AuthCacheService,
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
          companyId, key: bot.key, name: bot.name, persona: bot.persona, role: bot.role, avatar: bot.avatar ?? bot.key, description: bot.description, icon: bot.icon, instructions: bot.instructions,
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
      models: this.providers.models(),
      tools: this.catalog.all().map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, risk: tool.risk, permissions: [...tool.permissions, ...(tool.anyPermissions?.length ? [`uma de: ${tool.anyPermissions.join(', ')}`] : [])] })),
      enabled: process.env.AI_BOTS_ENABLED !== 'false',
      personalities: personalityCatalog(),
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
      id: bot.id, key: bot.key, name: bot.name, persona: bot.persona ?? bot.name, role: bot.role ?? bot.name, avatar: bot.avatar ?? bot.key, description: bot.description, icon: bot.icon, active: bot.active,
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
      // criado na tela (os padrão não têm "Excluir"; os criados não têm "Voltar ao padrão")
      custom: !BOT_DEFAULTS.some((item) => item.key === bot.key),
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
    if ('persona' in body) data.persona = clean(body.persona, 40) || null;
    if ('role' in body) data.role = clean(body.role, 80) || null;
    if ('avatar' in body) data.avatar = validAvatar(body.avatar);
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

  /**
   * Cria um bot novo na empresa: chave tirada do nome, permissão usar_bot_<chave>
   * dada ao perfil super (como os padrão) e a quem criou, e versão 1.
   */
  async create(actor: BotActor, body: Record<string, unknown>) {
    const persona = clean(body.persona, 40);
    if (persona.length < 2) throw new BadRequestException('Informe o nome do assistente');
    const name = clean(body.name, 80);
    if (name.length < 2) throw new BadRequestException('Informe a área do bot');
    const instructions = clean(body.instructions, 20000);
    if (instructions.length < 20) throw new BadRequestException('Escreva as instruções do bot (pelo menos uma frase sobre o que ele faz)');
    const tools = Array.isArray(body.tools) ? [...new Set(body.tools.map(String))] : [];
    const unknown = tools.filter((tool) => !this.catalog.get(tool));
    if (unknown.length) throw new BadRequestException(`Ferramentas desconhecidas: ${unknown.join(', ')}`);
    const provider = clean(body.provider, 20) || 'gemini';
    const model = clean(body.model, 80);
    if (!PROVIDER_LABELS[provider] && !(provider === 'fake' && process.env.NODE_ENV === 'test')) throw new BadRequestException('Fornecedor de IA inválido');
    if (model.length < 3) throw new BadRequestException('Informe o modelo');
    await this.ensureDefaults(actor.companyId);

    // chave livre na empresa (inclusive entre os excluídos) e que não seja de um padrão
    const base = slugKey(persona) || 'bot';
    const taken = new Set([
      ...BOT_DEFAULTS.map((item) => item.key),
      ...(await this.prisma.ai_Bot.findMany({ where: { companyId: actor.companyId }, select: { key: true } })).map((item) => item.key),
    ]);
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
    const permissionKey = `usar_bot_${key}`;
    const role = clean(body.role, 80) || null;
    const description = clean(body.description, 300) || `${persona}${role ? `, ${role}` : ''}`;

    const bot = await this.prisma.$transaction(async (tx) => {
      const permission = await tx.permission.upsert({
        where: { name: permissionKey },
        create: { name: permissionKey, description: `Conversar com ${persona} (${name})`.slice(0, 255), group: 'bots' },
        update: {},
      });
      const supers = await tx.profile.findMany({ where: { name: 'super', inactiveAt: null }, select: { id: true } });
      for (const profile of supers) {
        await tx.profilePermission.upsert({ where: { profileId_permissionId: { profileId: profile.id, permissionId: permission.id } }, create: { profileId: profile.id, permissionId: permission.id }, update: { inactiveAt: null } });
      }
      if (actor.userId) {
        await tx.userPermission.upsert({ where: { userId_permissionId: { userId: actor.userId, permissionId: permission.id } }, create: { userId: actor.userId, permissionId: permission.id }, update: { inactiveAt: null } });
      }
      return tx.ai_Bot.create({
        data: {
          companyId: actor.companyId, key, name, persona, role, description, avatar: validAvatar(body.avatar) ?? 'dados', instructions,
          tools, provider, model, permissionKey, shortcuts: [], icon: 'bot',
          versions: { create: { version: 1, instructions, tools, provider, model, userId: actor.userId || null } },
        },
      });
    });
    // a sessão guarda as permissões: sem isto, quem está logado só veria o bot no próximo login
    const users = await this.prisma.user.findMany({ where: { OR: [{ profile: { name: 'super' } }, ...(actor.userId ? [{ id: actor.userId }] : [])] }, select: { id: true } });
    await this.authCache.invalidateMultipleUsersCache(users.map((user) => user.id));
    return this.present(bot, [...actor.permissions, permissionKey], true);
  }

  /** Exclui um bot criado na tela (some da lista; conversas e versões ficam guardadas). Os padrão só desligam. */
  async archive(actor: BotActor, botId: number) {
    const bot = await this.prisma.ai_Bot.findFirst({ where: { id: botId, companyId: actor.companyId, inactiveAt: null } });
    if (!bot) throw new NotFoundException('Bot não encontrado');
    if (BOT_DEFAULTS.some((item) => item.key === bot.key)) throw new BadRequestException('Os bots padrão não podem ser excluídos: desligue em vez disso');
    await this.prisma.ai_Bot.update({ where: { id: bot.id }, data: { inactiveAt: new Date(), active: false } });
    return { ok: true };
  }

  /** Troca o modelo de todos os bots de uma vez (cada um ganha uma versão nova). */
  async applyModelToAll(actor: BotActor, body: Record<string, unknown>) {
    const provider = clean(body.provider, 20);
    const model = clean(body.model, 80);
    await this.ensureDefaults(actor.companyId);
    const bots = await this.prisma.ai_Bot.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { id: 'asc' } });
    let changed = 0;
    for (const bot of bots) {
      if (bot.provider === provider && bot.model === model) continue;
      await this.update(actor, bot.id, { provider, model });
      changed += 1;
    }
    return { changed, total: bots.length };
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
