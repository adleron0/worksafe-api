import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ChartAccountNature, Prisma, financialRecordsStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

export const MAX_LEVEL = 3;

/** Lançamento em aberto: impede inativar a conta que o classifica. */
const OPEN: financialRecordsStatus[] = ['waiting', 'overdue', 'processing'];
/** Fora dos totais da árvore: cobrança que não virou nem vai virar dinheiro. */
const NOT_COUNTED: financialRecordsStatus[] = ['cancelled', 'declined', 'chargeback'];

type Tx = Prisma.TransactionClient;
interface Actor { userId: number; companyId: number }

interface SeedNode { name: string; dreGroup?: string; children?: SeedNode[] }
const DEFAULT_CHART: Array<{ name: string; nature: ChartAccountNature; children: SeedNode[] }> = [
  { name: 'Receitas', nature: 'receita', children: [
    { name: 'Treinamentos', dreGroup: 'receita_bruta', children: [
      { name: 'Inscrições (turmas abertas)' }, { name: 'Turmas fechadas (in company)' }] },
    { name: 'Serviços', dreGroup: 'receita_bruta', children: [
      { name: 'Serviços em altura' }, { name: 'Brigada e resgate' }, { name: 'Outros serviços' }] },
    { name: 'Loja', dreGroup: 'receita_bruta', children: [{ name: 'Venda de produtos' }] },
    { name: 'Outras receitas', dreGroup: 'outras_receitas', children: [{ name: 'Rendimentos e reembolsos' }] },
  ] },
  { name: 'Despesas', nature: 'despesa', children: [
    { name: 'Pessoal', dreGroup: 'despesa_operacional' },
    { name: 'Estrutura e administrativo', dreGroup: 'despesa_operacional' },
    { name: 'Sistemas e comunicação', dreGroup: 'despesa_operacional' },
    { name: 'Jurídico, contábil e financeiro', dreGroup: 'despesa_operacional' },
    { name: 'Veículos, EPIs e materiais', dreGroup: 'custo_servico' },
    { name: 'Impostos', dreGroup: 'deducoes_impostos' },
  ] },
];
const DEFAULT_COST_CENTERS = ['Treinamentos', 'Serviços', 'Loja', 'Administrativo'];

const cleanName = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ');
const lastSegment = (code: string) => Number(code.split('.').pop());
/** Ordena 1.2 antes de 1.10 (texto puro inverteria). */
export const compareCodes = (a: string, b: string) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
};

@Injectable()
export class ChartAccountService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cria o plano padrão (raízes, grupos, centros de custo e classificação
   * automática da inscrição) na primeira vez que a empresa abre o financeiro.
   * Idempotente e protegido por trava: duas abas ao mesmo tempo não duplicam.
   */
  async ensureSeed(companyId: number): Promise<void> {
    const hasRoot = await this.prisma.financial_ChartAccount.findFirst({ where: { companyId, isSystem: true }, select: { id: true } });
    if (hasRoot) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(740113::int, ${companyId}::int)`;
      if (await tx.financial_ChartAccount.findFirst({ where: { companyId, isSystem: true }, select: { id: true } })) return;

      const byPath = new Map<string, number>();
      const create = async (node: SeedNode, parent: { id: number; code: string; level: number } | null, index: number, nature: ChartAccountNature, dreGroup?: string) => {
        const code = parent ? `${parent.code}.${index}` : String(index);
        const level = parent ? parent.level + 1 : 1;
        const group = node.dreGroup ?? dreGroup;
        const row = await tx.financial_ChartAccount.create({ data: {
          companyId, parentId: parent?.id ?? null, code, name: node.name, nature, level,
          acceptsEntries: !node.children?.length, dreGroup: group ?? null, isSystem: !parent,
        } });
        byPath.set(code, row.id);
        let i = 1;
        for (const child of node.children ?? []) await create(child, { id: row.id, code, level }, i++, nature, group);
      };
      let rootIndex = 1;
      for (const root of DEFAULT_CHART) await create(root, null, rootIndex++, root.nature);

      const centers = new Map<string, number>();
      for (const name of DEFAULT_COST_CENTERS) {
        const center = await tx.financial_CostCenter.upsert({ where: { companyId_name: { companyId, name } }, update: {}, create: { companyId, name } });
        centers.set(name, center.id);
      }
      await tx.financial_ClassificationDefault.upsert({
        where: { companyId_origin: { companyId, origin: 'inscricao' } },
        update: {},
        create: { companyId, origin: 'inscricao', chartAccountId: byPath.get('1.1.1'), costCenterId: centers.get('Treinamentos') },
      });
    });
  }

  /**
   * Lista plana, ordenada pelo código, com totais que SOBEM das filhas para as
   * mães. `month` (AAAA-MM) limita os totais à competência; sem ele, tudo.
   */
  async list(companyId: number, options: { month?: string; includeInactive?: boolean } = {}) {
    await this.ensureSeed(companyId);
    if (options.month && !/^\d{4}-\d{2}$/.test(options.month)) throw new BadRequestException('Mês deve estar no formato AAAA-MM');

    const accounts = await this.prisma.financial_ChartAccount.findMany({
      where: { companyId, ...(options.includeInactive ? {} : { inactiveAt: null }) },
    });
    const grouped = await this.prisma.financialRecords.groupBy({
      by: ['chartAccountId'],
      where: {
        companyId, inactiveAt: null, chartAccountId: { not: null }, status: { notIn: NOT_COUNTED },
        ...(options.month ? { accrualDate: options.month } : {}),
      },
      _count: { _all: true },
      _sum: { value: true },
    });

    // Sobe pela árvore inteira (inclusive contas inativas ocultas da resposta).
    const parents = new Map<number, number | null>(
      (await this.prisma.financial_ChartAccount.findMany({ where: { companyId }, select: { id: true, parentId: true } }))
        .map((a) => [a.id, a.parentId]),
    );
    const totals = new Map<number, { entries: number; value: number }>();
    for (const row of grouped) {
      let id: number | null | undefined = row.chartAccountId;
      while (id) {
        const total = totals.get(id) ?? { entries: 0, value: 0 };
        total.entries += row._count._all;
        total.value += Number(row._sum.value ?? 0);
        totals.set(id, total);
        id = parents.get(id);
      }
    }
    const childCount = new Map<number, number>();
    for (const account of accounts) if (account.parentId) childCount.set(account.parentId, (childCount.get(account.parentId) ?? 0) + 1);

    return accounts
      .sort((a, b) => compareCodes(a.code, b.code))
      .map((account) => ({
        ...account,
        children: childCount.get(account.id) ?? 0,
        entries: totals.get(account.id)?.entries ?? 0,
        total: Math.round((totals.get(account.id)?.value ?? 0) * 100) / 100,
      }));
  }

  private async lock(tx: Tx, companyId: number, ids: number[]) {
    await tx.$queryRaw`SELECT id FROM "Financial_ChartAccount" WHERE "companyId" = ${companyId} AND id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
  }

  private async findOwned(tx: Tx, companyId: number, id: number, what = 'Conta') {
    const account = await tx.financial_ChartAccount.findFirst({ where: { id, companyId } });
    if (!account) throw new NotFoundException(`${what} não encontrada`);
    return account;
  }

  private async assertUniqueName(tx: Tx, companyId: number, parentId: number, name: string, ignoreId?: number) {
    const dup = await tx.financial_ChartAccount.findFirst({
      where: { companyId, parentId, name: { equals: name, mode: 'insensitive' }, ...(ignoreId ? { NOT: { id: ignoreId } } : {}) },
      select: { id: true },
    });
    if (dup) throw new ConflictException('Já existe uma conta com esse nome nesta conta mãe');
  }

  /** Próximo número livre entre as irmãs (inativas contam: código não é reaproveitado). */
  private async nextCode(tx: Tx, companyId: number, parent: { id: number; code: string }) {
    const siblings = await tx.financial_ChartAccount.findMany({ where: { companyId, parentId: parent.id }, select: { code: true } });
    const next = siblings.reduce((max, s) => Math.max(max, lastSegment(s.code)), 0) + 1;
    return `${parent.code}.${next}`;
  }

  /**
   * Cria uma conta filha. Se a mãe já tinha lançamentos, eles passam para a
   * filha nova: lançamento nunca fica em conta mãe.
   */
  async create(input: { name?: unknown; parentId?: unknown; dreGroup?: unknown }, actor: Actor) {
    const name = cleanName(input.name);
    if (name.length < 2) throw new BadRequestException('Informe o nome da conta');
    if (name.length > 120) throw new BadRequestException('Nome com no máximo 120 caracteres');
    const parentId = Number(input.parentId);
    if (!Number.isInteger(parentId) || parentId < 1) throw new BadRequestException('Conta mãe obrigatória');
    await this.ensureSeed(actor.companyId);

    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, actor.companyId, [parentId]);
      const parent = await this.findOwned(tx, actor.companyId, parentId, 'Conta mãe');
      if (parent.inactiveAt) throw new ConflictException('A conta mãe está inativa');
      if (parent.level >= MAX_LEVEL) throw new ConflictException(`O plano de contas tem no máximo ${MAX_LEVEL} níveis`);
      await this.assertUniqueName(tx, actor.companyId, parent.id, name);

      const account = await tx.financial_ChartAccount.create({ data: {
        companyId: actor.companyId, parentId: parent.id, code: await this.nextCode(tx, actor.companyId, parent),
        name, nature: parent.nature, level: parent.level + 1,
        dreGroup: cleanName(input.dreGroup) || parent.dreGroup,
      } });

      let movedEntries = 0;
      if (parent.acceptsEntries) {
        movedEntries = (await tx.financialRecords.updateMany({ where: { companyId: actor.companyId, chartAccountId: parent.id }, data: { chartAccountId: account.id } })).count;
        await tx.financial_ClassificationDefault.updateMany({ where: { companyId: actor.companyId, chartAccountId: parent.id }, data: { chartAccountId: account.id } });
        await tx.financial_ChartAccount.update({ where: { id: parent.id }, data: { acceptsEntries: false } });
      }
      return { ...account, movedEntries };
    });
  }

  async update(id: number, input: { name?: unknown; dreGroup?: unknown }, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const account = await this.findOwned(tx, actor.companyId, id);
      if (account.isSystem) throw new ConflictException('As contas Receitas e Despesas não podem ser alteradas');
      const data: Prisma.Financial_ChartAccountUpdateInput = {};
      if (input.name !== undefined) {
        const name = cleanName(input.name);
        if (name.length < 2) throw new BadRequestException('Informe o nome da conta');
        if (name.length > 120) throw new BadRequestException('Nome com no máximo 120 caracteres');
        await this.assertUniqueName(tx, actor.companyId, account.parentId!, name, account.id);
        data.name = name;
      }
      if (input.dreGroup !== undefined) data.dreGroup = cleanName(input.dreGroup) || null;
      return tx.financial_ChartAccount.update({ where: { id }, data });
    });
  }

  /** Troca a conta de mãe, recodificando a conta e todas as suas filhas. */
  async move(id: number, newParentIdRaw: unknown, actor: Actor) {
    const newParentId = Number(newParentIdRaw);
    if (!Number.isInteger(newParentId) || newParentId < 1) throw new BadRequestException('Conta mãe de destino obrigatória');

    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, actor.companyId, [id, newParentId]);
      const account = await this.findOwned(tx, actor.companyId, id);
      const target = await this.findOwned(tx, actor.companyId, newParentId, 'Conta mãe de destino');
      if (account.isSystem) throw new ConflictException('As contas Receitas e Despesas não podem ser movidas');
      if (account.parentId === target.id) throw new ConflictException('A conta já está nesta conta mãe');
      if (target.id === account.id || target.code.startsWith(`${account.code}.`)) {
        throw new ConflictException('Não é possível mover uma conta para dentro dela mesma');
      }
      if (target.inactiveAt) throw new ConflictException('A conta mãe de destino está inativa');

      const subtree = await tx.financial_ChartAccount.findMany({
        where: { companyId: actor.companyId, OR: [{ id: account.id }, { code: { startsWith: `${account.code}.` } }] },
      });
      const depth = Math.max(...subtree.map((a) => a.level)) - account.level;
      if (target.level + 1 + depth > MAX_LEVEL) throw new ConflictException(`A mudança passaria de ${MAX_LEVEL} níveis`);
      await this.assertUniqueName(tx, actor.companyId, target.id, account.name, account.id);

      const subtreeIds = subtree.map((a) => a.id);
      if (target.nature !== account.nature) {
        const used = await tx.financialRecords.count({ where: { companyId: actor.companyId, chartAccountId: { in: subtreeIds } } });
        if (used > 0) throw new ConflictException('Esta conta tem lançamentos: não pode trocar entre Receitas e Despesas');
      }
      if (target.acceptsEntries) {
        const used = await tx.financialRecords.count({ where: { companyId: actor.companyId, chartAccountId: target.id } });
        if (used > 0) {
          throw new ConflictException(`${target.code} ${target.name} tem lançamentos. Crie uma conta filha nela antes (os lançamentos passam para a filha) e então mova`);
        }
      }

      const newCode = await this.nextCode(tx, actor.companyId, target);
      const delta = target.level + 1 - account.level;
      for (const node of subtree) {
        await tx.financial_ChartAccount.update({ where: { id: node.id }, data: {
          code: newCode + node.code.slice(account.code.length),
          level: node.level + delta,
          nature: target.nature,
          ...(node.id === account.id ? { parentId: target.id } : {}),
        } });
      }
      await tx.financial_ChartAccount.update({ where: { id: target.id }, data: { acceptsEntries: false } });
      // Mãe antiga sem filhas volta a aceitar lançamento (deixa de ser grupo vazio inutilizável).
      const oldParentId = account.parentId!;
      const remaining = await tx.financial_ChartAccount.count({ where: { companyId: actor.companyId, parentId: oldParentId } });
      if (remaining === 0) {
        const oldParent = await tx.financial_ChartAccount.findUnique({ where: { id: oldParentId } });
        if (oldParent && !oldParent.isSystem) await tx.financial_ChartAccount.update({ where: { id: oldParentId }, data: { acceptsEntries: true } });
      }
      return tx.financial_ChartAccount.findUnique({ where: { id: account.id } });
    });
  }

  async setActive(id: number, active: boolean, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, actor.companyId, [id]);
      const account = await this.findOwned(tx, actor.companyId, id);
      if (account.isSystem) throw new ConflictException('As contas Receitas e Despesas não podem ser inativadas');

      if (active) {
        if (!account.inactiveAt) return account;
        const parent = await tx.financial_ChartAccount.findUnique({ where: { id: account.parentId! } });
        if (parent?.inactiveAt) throw new ConflictException(`Reative antes a conta mãe ${parent.code} ${parent.name}`);
        return tx.financial_ChartAccount.update({ where: { id }, data: { inactiveAt: null } });
      }

      if (account.inactiveAt) return account;
      const activeChildren = await tx.financial_ChartAccount.count({ where: { companyId: actor.companyId, parentId: id, inactiveAt: null } });
      if (activeChildren > 0) throw new ConflictException('Inative antes as contas filhas ativas');
      const open = await tx.financialRecords.count({ where: { companyId: actor.companyId, chartAccountId: id, inactiveAt: null, status: { in: OPEN } } });
      if (open > 0) throw new ConflictException(`Há ${open} lançamento(s) em aberto nesta conta: reclassifique ou dê baixa antes de inativar`);
      const defaults = await tx.financial_ClassificationDefault.count({ where: { companyId: actor.companyId, chartAccountId: id } });
      if (defaults > 0) throw new ConflictException('Esta conta é usada na classificação automática: troque a conta padrão antes de inativar');
      return tx.financial_ChartAccount.update({ where: { id }, data: { inactiveAt: new Date() } });
    });
  }
}
