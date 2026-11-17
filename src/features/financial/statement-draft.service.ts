import { Prisma } from '@prisma/client';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { assertClassification } from './classification';
import { round } from './ledger.filters';
import { PayableActor } from './payable.service';
import { StatementLine, TreasuryService } from './treasury.service';

type Body = Record<string, any>;
const fail = (message: string): never => { throw new BadRequestException(message); };
const isDay = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
const toInt = (value: unknown) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined);
const MAX_LINES = 1500;
const ACTIONS = ['baixar', 'vincular', 'criar', 'transferir', 'ignorar'] as const;

/** O que o assistente (ou a pessoa) sugere para uma linha. Só vira lançamento na hora de lançar. */
export interface LineSuggestion {
  action?: (typeof ACTIONS)[number];
  type?: 'payable' | 'receivable';
  targetId?: number;
  chartAccountId?: number;
  costCenterId?: number;
  supplierId?: number;
  customerId?: number;
  otherBankAccountId?: number;
  description?: string;
  paymentMethod?: string;
}
export interface DraftLine extends StatementLine { suggestion?: LineSuggestion }

/** Histórico sem acento, caixa e pontuação: o mesmo lançamento lido duas vezes dá o mesmo texto. */
const normMemo = (memo: string) => memo.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Extrato que não veio em OFX (PDF lido pelo assistente, ou linhas mandadas
 * pelo MCP). Vira um rascunho com a conferência aritmética (saldo inicial +
 * lançamentos = saldo final) e depois segue pela mesma conciliação do OFX:
 * mesmo motor, mesmas ações, mesma proteção contra lançar duas vezes. O
 * identificador de cada linha é sintético e estável, então reenviar o mesmo
 * extrato cai em "já conciliado".
 */
@Injectable()
export class StatementDraftService {
  constructor(private readonly prisma: PrismaService, private readonly treasury: TreasuryService) {}

  async create(actor: PayableActor, body: Body, extras: { source?: string; botId?: number | null } = {}) {
    const bankAccountId = toInt(body.bankAccountId) ?? fail('Escolha a conta bancária do extrato');
    await assertClassification(this.prisma, actor.companyId, { bankAccountId });
    const opening = Number(body.openingBalance);
    const closing = Number(body.closingBalance);
    if (body.openingBalance === undefined || body.openingBalance === null || !Number.isFinite(opening)) fail('Informe o saldo inicial do extrato (o saldo anterior ao primeiro lançamento)');
    if (body.closingBalance === undefined || body.closingBalance === null || !Number.isFinite(closing)) fail('Informe o saldo final do extrato');
    const raw: Body[] = Array.isArray(body.lines) ? body.lines : [];
    if (!raw.length) fail('Nenhum lançamento no extrato');
    if (raw.length > MAX_LINES) fail(`Extrato com mais de ${MAX_LINES} linhas: divida em partes`);

    const seen = new Map<string, number>();
    const lines: DraftLine[] = raw.map((item, index) => {
      const date = String(item.date ?? '').slice(0, 10);
      const amount = round(Number(item.amount));
      if (!isDay(date)) fail(`Linha ${index + 1}: data inválida (use AAAA-MM-DD)`);
      if (!Number.isFinite(amount) || amount === 0) fail(`Linha ${index + 1}: valor inválido (saída negativa, entrada positiva)`);
      const memo = String(item.memo ?? item.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      // dois lançamentos iguais no mesmo dia (duas tarifas, por exemplo) recebem ordens diferentes
      const base = `${date}|${amount.toFixed(2)}|${normMemo(memo)}`;
      const nth = (seen.get(base) ?? 0) + 1;
      seen.set(base, nth);
      const fitId = `x${createHash('sha1').update(`${base}|${nth}`).digest('hex').slice(0, 24)}`;
      const suggestion = this.cleanSuggestion(item.suggestion);
      return { fitId, date, amount, memo, type: amount < 0 ? 'DEBIT' : 'CREDIT', ...(suggestion ? { suggestion } : {}) };
    });

    const dates = lines.map((line) => line.date).sort();
    const periodFrom = isDay(body.periodFrom) && body.periodFrom <= dates[0] ? body.periodFrom : dates[0];
    const periodTo = isDay(body.periodTo) && body.periodTo >= dates[dates.length - 1] ? body.periodTo : dates[dates.length - 1];
    const sum = lines.reduce((total, line) => total + line.amount, 0);
    const difference = round(round(opening) + sum - round(closing));
    const status = Math.abs(difference) < 0.01 ? 'rascunho' : 'nao_confere';

    const row = await this.prisma.financial_StatementDraft.create({
      data: {
        companyId: actor.companyId, bankAccountId, source: String(extras.source ?? body.source ?? 'pdf').slice(0, 10), status,
        fileName: body.fileName ? String(body.fileName).slice(0, 200) : null, periodFrom, periodTo,
        openingBalance: round(opening), closingBalance: round(closing), difference: Math.abs(difference) < 0.01 ? 0 : difference,
        lines: lines as unknown as Prisma.InputJsonValue, botId: extras.botId ?? null, createdByUserId: actor.userId || null,
      },
    });
    return this.view(actor.companyId, row.id);
  }

  async list(companyId: number, query: Body) {
    const status = query.status ? String(query.status).split(',').filter(Boolean) : undefined;
    const rows = await this.prisma.financial_StatementDraft.findMany({
      where: { companyId, ...(status?.length ? { status: { in: status } } : { status: { not: 'descartado' } }), ...(toInt(query.bankAccountId) ? { bankAccountId: toInt(query.bankAccountId) } : {}) },
      orderBy: { id: 'desc' }, take: 50,
      select: { id: true, bankAccountId: true, source: true, status: true, fileName: true, periodFrom: true, periodTo: true, openingBalance: true, closingBalance: true, difference: true, createdAt: true, appliedAt: true, bankAccount: { select: { name: true } } },
    });
    return rows.map((row) => ({ ...row, openingBalance: Number(row.openingBalance), closingBalance: Number(row.closingBalance), difference: Number(row.difference), bankAccount: row.bankAccount.name }));
  }

  private async find(companyId: number, id: number) {
    const row = await this.prisma.financial_StatementDraft.findFirst({ where: { id, companyId }, include: { bankAccount: { select: { id: true, name: true } } } });
    if (!row) throw new NotFoundException('Extrato não encontrado');
    return row;
  }

  /** O rascunho com a mesma resposta da conciliação, mais a ação proposta para cada linha. */
  async view(companyId: number, id: number) {
    const row = await this.find(companyId, id);
    const lines = row.lines as unknown as DraftLine[];
    const preview = await this.treasury.previewLines(companyId, row.bankAccountId, lines, { amount: Number(row.closingBalance), date: row.periodTo });
    const byFit = new Map(lines.map((line) => [line.fitId, line]));
    const items = preview.items.map((item) => {
      const suggestion = byFit.get(item.fitId)?.suggestion;
      return { ...item, suggestion: suggestion ?? null, proposed: this.propose(item, suggestion) };
    });
    const credits = lines.filter((line) => line.amount > 0).reduce((total, line) => total + line.amount, 0);
    const debits = lines.filter((line) => line.amount < 0).reduce((total, line) => total + line.amount, 0);
    return {
      id: row.id, status: row.status, source: row.source, fileName: row.fileName, botId: row.botId,
      bankAccount: row.bankAccount, period: { from: row.periodFrom, to: row.periodTo },
      check: {
        opening: Number(row.openingBalance), closing: Number(row.closingBalance), credits: round(credits), debits: round(debits),
        difference: Number(row.difference), ok: Math.abs(Number(row.difference)) < 0.01,
      },
      appliedAt: row.appliedAt, applyResult: row.applyResult,
      ...preview, items,
    };
  }

  /** Ação que será aplicada se ninguém mudar nada: a sugestão, senão o par encontrado, senão criar. */
  private propose(item: { status: string; amount: number; candidates: Array<{ type: string; mode: string; id: number }> }, suggestion?: LineSuggestion) {
    if (item.status === 'conciliado' || item.status === 'antes_inicio') return null;
    if (suggestion?.action) return suggestion;
    const best = item.candidates[0];
    if (best) return { action: best.mode, type: best.type, targetId: best.id };
    return { action: 'criar' };
  }

  /** Guarda as sugestões (categoria, fornecedor, ação) de uma ou mais linhas. */
  async suggest(actor: PayableActor, id: number, body: Body) {
    const row = await this.find(actor.companyId, id);
    if (['lancado', 'descartado'].includes(row.status)) fail('Este extrato já foi lançado ou descartado');
    const lines = row.lines as unknown as DraftLine[];
    const changes: Body[] = Array.isArray(body.items) ? body.items : [];
    if (!changes.length) fail('Nenhuma sugestão');
    let changed = 0;
    for (const change of changes) {
      const line = change.fitId ? lines.find((item) => item.fitId === change.fitId) : lines[Number(change.index)];
      if (!line) continue;
      const suggestion = this.cleanSuggestion(change);
      if (!suggestion) continue;
      await assertClassification(this.prisma, actor.companyId, { chartAccountId: suggestion.chartAccountId ?? null, costCenterId: suggestion.costCenterId ?? null });
      line.suggestion = { ...(line.suggestion ?? {}), ...suggestion };
      changed++;
    }
    await this.prisma.financial_StatementDraft.update({ where: { id: row.id }, data: { lines: lines as unknown as Prisma.InputJsonValue } });
    return { changed, draft: await this.view(actor.companyId, id) };
  }

  private cleanSuggestion(input: unknown): LineSuggestion | null {
    if (!input || typeof input !== 'object') return null;
    const raw = input as Body;
    const out: LineSuggestion = {};
    if (ACTIONS.includes(raw.action)) out.action = raw.action;
    if (raw.type === 'payable' || raw.type === 'receivable') out.type = raw.type;
    for (const key of ['targetId', 'chartAccountId', 'costCenterId', 'supplierId', 'customerId', 'otherBankAccountId'] as const) {
      const value = toInt(raw[key]);
      if (value) out[key] = value;
    }
    if (raw.description) out.description = String(raw.description).slice(0, 255);
    if (raw.paymentMethod) out.paymentMethod = String(raw.paymentMethod).slice(0, 20);
    return Object.keys(out).length ? out : null;
  }

  /**
   * Lança o rascunho pela conciliação. Sem `items` no corpo, usa a ação
   * proposta de cada linha; a tela manda `items` quando a pessoa ajustou.
   * Extrato cuja soma não confere não é lançado.
   */
  async apply(actor: PayableActor, id: number, body: Body = {}) {
    const row = await this.find(actor.companyId, id);
    if (row.status === 'nao_confere') fail(`A soma do extrato não confere (diferença de ${Number(row.difference).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}): corrija a leitura antes de lançar`);
    if (row.status === 'lancado') fail('Este extrato já foi lançado');
    if (row.status === 'descartado') fail('Este extrato foi descartado');
    const draft = await this.view(actor.companyId, id);
    const fits = new Set(draft.items.map((item) => item.fitId));
    let items: Body[];
    if (Array.isArray(body.items)) {
      items = body.items.filter((item: Body) => fits.has(String(item.fitId)));
    } else {
      items = draft.items.filter((item) => item.proposed).map((item) => ({ ...item.proposed, fitId: item.fitId, date: item.date, amount: item.amount, memo: item.memo }));
    }
    const pending = items.filter((item) => item.action && item.action !== 'ignorar');
    if (!pending.length) fail('Nada para lançar: as linhas já estão conciliadas ou foram ignoradas');
    const result = await this.treasury.apply(actor, { bankAccountId: row.bankAccountId, items });
    const ignored = new Set(items.filter((item) => item.action === 'ignorar').map((item) => String(item.fitId)));
    const remaining = (await this.view(actor.companyId, id)).items.filter((item) => item.status !== 'conciliado' && item.status !== 'antes_inicio' && !ignored.has(item.fitId)).length;
    const status = result.errors.length || remaining ? 'parcial' : 'lancado';
    await this.prisma.financial_StatementDraft.update({
      where: { id: row.id },
      data: { status, appliedAt: new Date(), applyResult: { applied: result.applied, errors: result.errors.slice(0, 50) } as unknown as Prisma.InputJsonValue },
    });
    return { ...result, status, remaining };
  }

  async discard(actor: PayableActor, id: number) {
    const row = await this.find(actor.companyId, id);
    if (row.status === 'lancado') fail('Extrato já lançado: estorne pela conciliação, linha a linha');
    await this.prisma.financial_StatementDraft.update({ where: { id: row.id }, data: { status: 'descartado' } });
    return { id: row.id, status: 'descartado' };
  }
}
