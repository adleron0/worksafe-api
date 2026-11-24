import { BadRequestException, Injectable } from '@nestjs/common';
import { Ai_Settings, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatUsage } from '../providers/provider.types';
import { PROVIDER_LABELS, isTestProvider } from '../providers/provider.registry';

export const monthOf = (date = new Date()) => new Date(date.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 7);
/** Início do mês no horário de Brasília (o "virar o mês" do teto). */
export const monthStart = (month = monthOf()) => new Date(`${month}-01T03:00:00.000Z`);
const nextMonthStart = (month = monthOf()) => {
  const [year, m] = month.split('-').map(Number);
  return monthStart(`${m === 12 ? year + 1 : year}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`);
};

export const ON_EXCEED = ['parar', 'economico'] as const;
export type OnExceed = (typeof ON_EXCEED)[number];
const DEFAULT_BUDGET = 50;
const round = (value: number) => Math.round(value * 10000) / 10000;

export interface ModelTarget { provider: string; model: string }

/**
 * Situação do teto para uma execução:
 * - ok: segue normal;
 * - economy: passou do teto e a empresa escolheu "passar para o econômico" (todos os passos no modelo econômico da empresa);
 * - stop: passou do teto (ou do limite do servidor) e para.
 */
export interface BudgetState {
  mode: 'ok' | 'economy' | 'stop';
  economy: ModelTarget | null;
  reason: string | null;
}

/**
 * Gasto com IA por mês e o teto. O teto vem da tela (Ai_Settings, por
 * empresa); a variável AI_MONTHLY_BUDGET_USD, se existir, é o padrão e o
 * limite superior (passou dela, para sempre). Sem nenhum dos dois, US$ 50.
 */
@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService) {}

  /** Limite do servidor (variável), ou null se não houver. */
  envCap(): number | null {
    const raw = process.env.AI_MONTHLY_BUDGET_USD;
    if (raw === undefined || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  /** Teto padrão (sem empresa): a variável ou US$ 50. */
  budget(): number {
    return this.envCap() ?? DEFAULT_BUDGET;
  }

  settingsOf(companyId: number): Promise<Ai_Settings | null> {
    return this.prisma.ai_Settings.findUnique({ where: { companyId } });
  }

  /** Teto efetivo da empresa: o da tela, limitado pela variável. */
  effectiveBudget(settings: Ai_Settings | null): number {
    const env = this.envCap();
    const own = settings?.monthlyBudgetUsd != null ? Number(settings.monthlyBudgetUsd) : null;
    if (own == null) return env ?? DEFAULT_BUDGET;
    return env == null ? own : Math.min(own, env);
  }

  async record(companyId: number, provider: string, model: string, usage: ChatUsage, cost: number): Promise<void> {
    const month = monthOf();
    await this.prisma.ai_Usage.upsert({
      where: { companyId_month_provider_model: { companyId, month, provider, model } },
      create: { companyId, month, provider, model, calls: 1, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: cost },
      update: { calls: { increment: 1 }, inputTokens: { increment: usage.inputTokens }, outputTokens: { increment: usage.outputTokens }, costUsd: { increment: cost } },
    });
  }

  async spent(companyId: number, month = monthOf()): Promise<number> {
    const sum = await this.prisma.ai_Usage.aggregate({ where: { companyId, month }, _sum: { costUsd: true } });
    return Number(sum._sum.costUsd ?? 0);
  }

  /** Gasto do mês de um bot (execuções das conversas dele, de qualquer origem). */
  async botSpent(companyId: number, botId: number, month = monthOf()): Promise<number> {
    const sum = await this.prisma.ai_Run.aggregate({
      where: { startedAt: { gte: monthStart(month), lt: nextMonthStart(month) }, conversation: { companyId, botId } },
      _sum: { costUsd: true },
    });
    return Number(sum._sum.costUsd ?? 0);
  }

  /** Teto de um bot (dólares), se configurado. */
  botBudget(settings: Ai_Settings | null, botId: number): number | null {
    const value = Number(((settings?.botBudgets ?? {}) as Record<string, unknown>)[String(botId)]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /**
   * Situação do teto para a empresa (e, se informado, para o bot). Também dá
   * o aviso de X% uma vez por mês.
   */
  async state(companyId: number, botId?: number | null): Promise<BudgetState> {
    const settings = await this.settingsOf(companyId);
    const spent = await this.spent(companyId);
    const env = this.envCap();
    if (env != null && spent >= env) return { mode: 'stop', economy: null, reason: 'O teto mensal de gasto com IA foi atingido.' };
    const budget = this.effectiveBudget(settings);
    await this.warnIfNeeded(companyId, settings, spent, budget).catch((error) => console.error('[ai] aviso de gasto falhou', error));
    let over = spent >= budget;
    let reason = 'O teto mensal de gasto com IA foi atingido.';
    if (!over && botId) {
      const cap = this.botBudget(settings, botId);
      if (cap != null && (await this.botSpent(companyId, botId)) >= cap) { over = true; reason = 'O teto mensal de gasto deste bot foi atingido.'; }
    }
    if (!over) return { mode: 'ok', economy: null, reason: null };
    const economy = settings?.onExceed === 'economico' && settings.economyProvider && settings.economyModel ? { provider: settings.economyProvider, model: settings.economyModel } : null;
    return economy ? { mode: 'economy', economy, reason } : { mode: 'stop', economy: null, reason };
  }

  /** Para quem só precisa saber se pode chamar o modelo (no modo econômico, pode). */
  async overBudget(companyId: number, botId?: number | null): Promise<boolean> {
    return (await this.state(companyId, botId)).mode === 'stop';
  }

  /** Aviso de X% do teto: um relatório no sistema (visto por quem configura os bots), uma vez por mês. */
  private async warnIfNeeded(companyId: number, settings: Ai_Settings | null, spent: number, budget: number) {
    const percent = settings?.warnPercent ?? 80;
    if (budget <= 0 || percent <= 0 || spent < (budget * percent) / 100) return;
    const month = monthOf();
    if (settings?.warnedMonth === month) return;
    // marca primeiro (atômico): duas execuções ao mesmo tempo não avisam duas vezes
    if (settings) {
      const marked = await this.prisma.ai_Settings.updateMany({ where: { companyId, OR: [{ warnedMonth: null }, { warnedMonth: { not: month } }] }, data: { warnedMonth: month } });
      if (!marked.count) return;
    } else {
      try {
        await this.prisma.ai_Settings.create({ data: { companyId, warnedMonth: month } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
        throw error;
      }
    }
    const used = Math.round((spent / budget) * 100);
    const exceed = settings?.onExceed === 'economico' ? 'passar todos os bots para o modelo econômico' : 'parar os bots';
    await this.prisma.ai_Report.create({
      data: {
        companyId, title: `Gasto com IA chegou a ${used}% do teto do mês`,
        body: `O gasto com IA em ${month} está em **US$ ${spent.toFixed(2)}**, ${used}% do teto de **US$ ${budget.toFixed(2)}**.\n\nAo atingir o teto, o sistema vai ${exceed}. Ajuste em Bots → Configurar bots → Economia.`,
      },
    });
  }

  async summary(companyId: number, month = monthOf()) {
    const rows = await this.prisma.ai_Usage.findMany({ where: { companyId, month }, orderBy: { costUsd: 'desc' } });
    const spent = rows.reduce((sum, row) => sum + Number(row.costUsd), 0);
    const settings = await this.settingsOf(companyId);
    const budget = this.effectiveBudget(settings);
    const warnPercent = settings?.warnPercent ?? 80;
    return {
      month, budget, spent: Number(spent.toFixed(4)), percent: budget > 0 ? Math.round((spent / budget) * 100) : null,
      warning: budget > 0 && spent >= (budget * warnPercent) / 100,
      rows: rows.map((row) => ({ provider: row.provider, model: row.model, calls: row.calls, inputTokens: row.inputTokens, outputTokens: row.outputTokens, costUsd: Number(Number(row.costUsd).toFixed(4)) })),
    };
  }

  // ---------------------------------------------------------------- tela (Configurar bots → Economia)

  async budgetView(companyId: number) {
    const settings = await this.settingsOf(companyId);
    const [spent, state] = await Promise.all([this.spent(companyId), this.state(companyId)]);
    const budget = this.effectiveBudget(settings);
    const warnPercent = settings?.warnPercent ?? 80;
    return {
      month: monthOf(),
      monthlyBudgetUsd: settings?.monthlyBudgetUsd != null ? Number(settings.monthlyBudgetUsd) : null,
      warnPercent,
      onExceed: (settings?.onExceed ?? 'parar') as OnExceed,
      economyProvider: settings?.economyProvider ?? null,
      economyModel: settings?.economyModel ?? null,
      maxPrecision: !!settings?.maxPrecision,
      botBudgets: (settings?.botBudgets ?? {}) as Record<string, number>,
      envCap: this.envCap(),
      budget, spent: round(spent),
      percent: budget > 0 ? Math.round((spent / budget) * 100) : null,
      warning: budget > 0 && spent >= (budget * warnPercent) / 100,
      mode: state.mode,
    };
  }

  async saveBudget(companyId: number, userId: number | null, body: Record<string, unknown>) {
    const data: Prisma.Ai_SettingsUncheckedCreateInput = { companyId, updatedByUserId: userId || null };
    if ('monthlyBudgetUsd' in body) {
      const raw = body.monthlyBudgetUsd;
      if (raw === null || raw === '') data.monthlyBudgetUsd = null;
      else {
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > 100000) throw new BadRequestException('Teto mensal inválido');
        data.monthlyBudgetUsd = Math.round(value * 100) / 100;
      }
    }
    if ('warnPercent' in body) {
      const value = Math.round(Number(body.warnPercent));
      if (!Number.isFinite(value) || value < 1 || value > 100) throw new BadRequestException('O aviso vai de 1% a 100%');
      data.warnPercent = value;
    }
    if ('onExceed' in body) {
      if (!ON_EXCEED.includes(body.onExceed as OnExceed)) throw new BadRequestException('Ao estourar: parar ou economico');
      data.onExceed = body.onExceed as string;
    }
    if ('economyProvider' in body || 'economyModel' in body) {
      const provider = String(body.economyProvider ?? '').trim().slice(0, 20);
      const model = String(body.economyModel ?? '').trim().slice(0, 80);
      if (!provider && !model) { data.economyProvider = null; data.economyModel = null; } else {
        if (!PROVIDER_LABELS[provider] && !isTestProvider(provider)) throw new BadRequestException('Fornecedor de IA inválido');
        if (model.length < 3) throw new BadRequestException('Informe o modelo econômico');
        data.economyProvider = provider; data.economyModel = model;
      }
    }
    if ('maxPrecision' in body) data.maxPrecision = body.maxPrecision === true || body.maxPrecision === 'true';
    if ('botBudgets' in body) {
      const raw = body.botBudgets;
      if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw new BadRequestException('Teto por bot inválido');
      const out: Record<string, number> = {};
      for (const [key, value] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
        if (value === null || value === '' || value === undefined) continue;
        const amount = Number(value);
        if (!/^\d+$/.test(key) || !Number.isFinite(amount) || amount < 0 || amount > 100000) throw new BadRequestException('Teto por bot inválido');
        if (amount > 0) out[key] = Math.round(amount * 10000) / 10000;
      }
      data.botBudgets = out;
    }
    const next = { ...(await this.settingsOf(companyId)), ...data } as Ai_Settings;
    if (next.onExceed === 'economico' && (!next.economyProvider || !next.economyModel)) throw new BadRequestException('Escolha o modelo econômico para "passar para o econômico" ao estourar');
    const { companyId: _c, ...update } = data;
    await this.prisma.ai_Settings.upsert({ where: { companyId }, create: data, update });
    return this.budgetView(companyId);
  }

  // ---------------------------------------------------------------- auditoria: gasto por bot

  /**
   * Gasto do mês por bot (soma das execuções das conversas de cada bot),
   * agendamentos numa linha própria, MCP (o modelo é o do app de IA, sem
   * custo aqui) e o resto (resumos de conversa etc.), mais o gasto por modelo.
   */
  async byBot(companyId: number, month = monthOf()) {
    const [runs, bots, mcpCalls, usage] = await Promise.all([
      this.prisma.ai_Run.findMany({
        where: { startedAt: { gte: monthStart(month), lt: nextMonthStart(month) }, conversation: { companyId } },
        select: { costUsd: true, economyCostUsd: true, primarySteps: true, economySteps: true, escalations: true, conversation: { select: { botId: true, origin: true } } },
      }),
      this.prisma.ai_Bot.findMany({ where: { companyId }, select: { id: true, name: true, persona: true, model: true, economyModel: true, economyMode: true } }),
      this.prisma.ai_ToolCall.count({ where: { companyId, origin: 'mcp', createdAt: { gte: monthStart(month), lt: nextMonthStart(month) } } }),
      this.summary(companyId, month),
    ]);
    const settings = await this.settingsOf(companyId);
    const botOf = new Map(bots.map((bot) => [bot.id, bot]));
    type Row = { kind: 'bot' | 'schedule' | 'mcp' | 'other'; botId: number | null; label: string; runs: number; costUsd: number; economyCostUsd: number; primarySteps: number; economySteps: number; escalations: number; budgetUsd?: number | null; model?: string | null; economyModel?: string | null; economyMode?: boolean };
    const rows = new Map<string, Row>();
    const empty = (kind: Row['kind'], botId: number | null, label: string): Row => ({ kind, botId, label, runs: 0, costUsd: 0, economyCostUsd: 0, primarySteps: 0, economySteps: 0, escalations: 0 });
    for (const run of runs) {
      const schedule = run.conversation.origin === 'schedule';
      const key = schedule ? 'schedule' : `bot:${run.conversation.botId}`;
      if (!rows.has(key)) {
        const bot = botOf.get(run.conversation.botId);
        rows.set(key, schedule ? empty('schedule', null, 'Agendamentos') : { ...empty('bot', run.conversation.botId, bot ? `${bot.persona ?? bot.name} (${bot.name})` : `Bot #${run.conversation.botId}`), budgetUsd: this.botBudget(settings, run.conversation.botId), model: bot?.model ?? null, economyModel: bot?.economyModel ?? null, economyMode: !!bot?.economyMode });
      }
      const row = rows.get(key)!;
      row.runs += 1;
      row.costUsd += Number(run.costUsd);
      row.economyCostUsd += Number(run.economyCostUsd);
      row.primarySteps += run.primarySteps;
      row.economySteps += run.economySteps;
      row.escalations += run.escalations;
    }
    const list = [...rows.values()].sort((a, b) => b.costUsd - a.costUsd);
    const inRuns = list.reduce((sum, row) => sum + row.costUsd, 0);
    const other = usage.spent - inRuns;
    if (other > 0.00005) list.push({ ...empty('other', null, 'Resumos de conversa e outros'), costUsd: other });
    if (mcpCalls) list.push({ ...empty('mcp', null, 'MCP (app de IA da pessoa; o modelo não é cobrado aqui)'), runs: mcpCalls });
    return {
      month, total: usage.spent, budget: usage.budget,
      rows: list.map((row) => ({ ...row, costUsd: round(row.costUsd), economyCostUsd: round(row.economyCostUsd) })),
      byModel: usage.rows,
    };
  }
}
