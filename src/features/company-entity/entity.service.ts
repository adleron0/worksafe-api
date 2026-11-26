import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { ibgeOf } from 'src/features/fiscal/fiscal.utils';
import { entityScope } from './entity-scope';

export type EntityKind = 'treinamento' | 'servico' | 'locacao';
export const ENTITY_KINDS: EntityKind[] = ['treinamento', 'servico', 'locacao'];
export interface EntityActor { userId: number; companyId: number }

type EntityRow = Prisma.Company_EntityGetPayload<{ include: { city: true; state: true } }>;

/** CNPJ do grupo como documentos, notas e cobranças precisam dele. */
export interface EntityIdentity {
  entityId: number;
  companyId: number;
  cnpj: string;
  name: string; // razão social
  tradeName: string;
  ibge: string | null;
  cityName: string | null;
  uf: string | null;
  zipCode: string | null;
  address: string;
  addressLines: string[];
  email: string | null;
  phone: string | null;
  logoUrl: string | null;
  color: string | null;
  municipalRegistration: string | null;
  stateRegistration: string | null;
  brand: Record<string, unknown> | null;
}

const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const clean = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Endereço em até duas linhas: "Rua, número, complemento" e "Bairro - Cidade - UF - CEP 00000-000" (o formato dos documentos). */
export function addressLines(street: Array<string | number | null | undefined>, neighborhood?: string | null, city?: string | null, uf?: string | null, zip?: string | null): string[] {
  const d = String(zip ?? '').replace(/\D/g, '');
  const cep = d.length === 8 ? `CEP ${d.slice(0, 5)}-${d.slice(5)}` : '';
  const [road, number, complement] = street.map((part) => String(part ?? '').trim());
  const numbered = road ? [road, number && number !== '0' ? number : '', complement] : [];
  return [
    numbered.filter(Boolean).join(', '),
    [neighborhood, city, uf, cep].map((part) => String(part ?? '').trim()).filter(Boolean).join(' - '),
  ].filter(Boolean);
}

/** Valida o CNPJ pelos dígitos verificadores. */
export function validCnpj(value: string) {
  const c = digits(value);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const calc = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((s, w, i) => s + Number(c[i]) * w, 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

/** Tabelas com CNPJ do grupo preenchido pelo banco (gatilho ws_entity_fill). */
const ENTITY_TABLES = ['Commercial_Contract', 'Commercial_Proposal', 'CompanyGateWays', 'Course', 'CourseClass', 'FinancialRecords', 'Financial_BankAccount',
  'Financial_Payable', 'Financial_Recurrence', 'Fiscal_Invoice', 'Fiscal_ReceivedInvoice', 'Fiscal_Settings', 'Hr_Employee', 'Service_Order', 'Stock_Rental'];

/** Tabelas que têm CNPJ do grupo, com o nome que a tela mostra. */
const USAGE: Array<{ key: string; label: string; model: string }> = [
  { key: 'courses', label: 'Cursos', model: 'course' },
  { key: 'classes', label: 'Turmas', model: 'courseClass' },
  { key: 'proposals', label: 'Propostas', model: 'commercial_Proposal' },
  { key: 'contracts', label: 'Contratos', model: 'commercial_Contract' },
  { key: 'serviceOrders', label: 'Ordens de serviço', model: 'service_Order' },
  { key: 'rentals', label: 'Ordens de locação', model: 'stock_Rental' },
  { key: 'receivables', label: 'Contas a receber', model: 'financialRecords' },
  { key: 'payables', label: 'Contas a pagar', model: 'financial_Payable' },
  { key: 'bankAccounts', label: 'Contas bancárias', model: 'financial_BankAccount' },
  { key: 'invoices', label: 'Notas fiscais', model: 'fiscal_Invoice' },
  { key: 'employees', label: 'Funcionários', model: 'hr_Employee' },
];

/**
 * Empresas do grupo: os CNPJs da WorkSafe dentro do mesmo sistema. Cada
 * registro diz de qual CNPJ é (entityId). Quem não escolhe recebe o CNPJ da
 * frente (treinamento, serviço, locação) ou o padrão: o banco preenche isso
 * sozinho (gatilho ws_entity_fill), e este serviço faz o mesmo na aplicação.
 */
@Injectable()
export class CompanyEntityService {
  constructor(private readonly prisma: PrismaService) {}

  private include = { city: true, state: true } as const;

  async list(companyId: number, all = false) {
    await this.ensureFirst(companyId);
    const allowed = entityScope.allowed();
    const rows = await this.prisma.company_Entity.findMany({
      where: { companyId, ...(all ? {} : { inactiveAt: null }), ...(allowed ? { id: { in: allowed } } : {}) },
      include: this.include,
      orderBy: [{ inactiveAt: { sort: 'asc', nulls: 'first' } }, { isDefault: 'desc' }, { id: 'asc' }],
    });
    return rows.map((r) => this.out(r));
  }

  async get(companyId: number, id: number) {
    const row = await this.prisma.company_Entity.findFirst({ where: { id, companyId }, include: this.include });
    if (!row) throw new NotFoundException('CNPJ do grupo não encontrado');
    return row;
  }

  out(r: EntityRow) {
    return {
      id: r.id, cnpj: r.cnpj, corporateName: r.corporateName, tradeName: r.tradeName, kinds: r.kinds, isDefault: r.isDefault,
      color: r.color, logoUrl: r.logoUrl, stateId: r.stateId, cityId: r.cityId, cityName: r.city?.name ?? null, uf: r.state?.uf ?? null,
      zipCode: r.zipCode, address: r.address, addressNumber: r.addressNumber, addressComplement: r.addressComplement, neighborhood: r.neighborhood,
      email: r.email, phone: r.phone, municipalRegistration: r.municipalRegistration, stateRegistration: r.stateRegistration,
      brand: r.brand, active: !r.inactiveAt, inactiveAt: r.inactiveAt, createdAt: r.createdAt,
    };
  }

  /**
   * O CNPJ de um registro: o informado (conferindo que é do grupo), senão o
   * da frente, senão o padrão. Nunca devolve nulo enquanto houver um CNPJ.
   */
  async resolveId(companyId: number, entityId?: unknown, kind?: string | null): Promise<number> {
    const id = Number(entityId);
    if (entityId !== undefined && entityId !== null && entityId !== '' && Number.isInteger(id) && id > 0) {
      const found = await this.prisma.company_Entity.findFirst({ where: { id, companyId }, select: { id: true, inactiveAt: true } });
      if (!found) throw new BadRequestException('CNPJ do grupo não encontrado');
      const allowed = entityScope.allowed();
      if (allowed && !allowed.includes(found.id)) throw new ForbiddenException('Seu usuário não tem acesso a este CNPJ do grupo');
      return found.id;
    }
    let rows = await this.prisma.company_Entity.findMany({ where: { companyId, inactiveAt: null }, orderBy: [{ isDefault: 'desc' }, { id: 'asc' }], select: { id: true, kinds: true } });
    if (!rows.length) {
      await this.ensureFirst(companyId);
      rows = await this.prisma.company_Entity.findMany({ where: { companyId, inactiveAt: null }, orderBy: [{ isDefault: 'desc' }, { id: 'asc' }], select: { id: true, kinds: true } });
    }
    if (!rows.length) throw new BadRequestException('Cadastre o CNPJ da empresa em Configurações → Empresas do grupo');
    // usuário limitado: escolhe entre os CNPJs dele (o da frente, senão o primeiro)
    const allowed = entityScope.allowed();
    if (allowed) {
      rows = rows.filter((r) => allowed.includes(r.id));
      if (!rows.length) throw new ForbiddenException('Seu usuário não tem acesso a nenhum CNPJ ativo do grupo');
    }
    return (kind ? rows.find((r) => r.kinds.includes(kind)) : null)?.id ?? rows[0].id;
  }

  /**
   * Empresa sem nenhum CNPJ cadastrado (base nova): o cadastro da empresa vira o
   * primeiro, padrão e de todas as frentes, como a migração fez com a base antiga.
   */
  async ensureFirst(companyId: number) {
    const any = await this.prisma.company_Entity.count({ where: { companyId } });
    if (any) return;
    const c = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!c) return;
    await this.prisma.company_Entity.create({
      data: {
        companyId, cnpj: digits(c.cnpj).slice(0, 14), corporateName: c.corporate_name || c.comercial_name, tradeName: (c.comercial_name || c.corporate_name).slice(0, 120),
        kinds: [...ENTITY_KINDS], isDefault: true, logoUrl: c.logoUrl, stateId: c.stateId, cityId: c.cityId, zipCode: c.zipCode?.slice(0, 9) ?? null,
        address: c.address, addressNumber: c.addressNumber?.slice(0, 20) ?? null, addressComplement: c.addressComplement?.slice(0, 120) ?? null,
        neighborhood: c.neighborhood?.slice(0, 120) ?? null, email: c.financial_email || c.representative_email || null,
        phone: (c.financial_contact || c.representative_contact || '').slice(0, 30) || null,
      },
    }).catch(() => undefined); // outra requisição criou ao mesmo tempo
    // o que já existia sem CNPJ (base nova) fica com este, como a migração fez na base antiga
    for (const table of ENTITY_TABLES) {
      await this.prisma.$executeRawUnsafe(`UPDATE "${table}" SET "entityId" = ws_entity_default("companyId", NULL) WHERE "entityId" IS NULL AND "companyId" = $1`, companyId);
    }
  }

  /** entityId recebido de um formulário: número válido do grupo, ou undefined (não mexer). */
  async optionalId(companyId: number, value: unknown): Promise<number | undefined> {
    if (value === undefined || value === null || value === '') return undefined;
    return this.resolveId(companyId, value);
  }

  async identity(companyId: number, entityId?: number | null, kind?: string | null): Promise<EntityIdentity> {
    const id = await this.resolveId(companyId, entityId ?? undefined, kind);
    const r = await this.get(companyId, id);
    // o CNPJ principal (o mesmo do cadastro da empresa): o que está em branco nele vem
    // do cadastro da empresa, que continua editável na tela "Empresa"
    const c = await this.prisma.company.findUnique({ where: { id: companyId }, include: { city: true, state: true } });
    const main = !!c && digits(c.cnpj) === digits(r.cnpj);
    const pick = <T>(own: T | null | undefined, fallback: T | null | undefined): T | null => (own !== null && own !== undefined && own !== '' ? own : main ? fallback ?? null : null);
    const city = r.city ?? (main ? c?.city ?? null : null);
    const uf = r.state?.uf ?? (main ? c?.state?.uf ?? null : null);
    const address = pick(r.address, c?.address);
    const number = pick(r.addressNumber, c?.addressNumber);
    const complement = pick(r.addressComplement, c?.addressComplement);
    const neighborhood = pick(r.neighborhood, c?.neighborhood);
    const zip = pick(r.zipCode, c?.zipCode);
    return {
      entityId: r.id, companyId, cnpj: digits(r.cnpj), name: r.corporateName, tradeName: r.tradeName,
      ibge: city ? ibgeOf(city.name, uf) : null, cityName: city?.name ?? null, uf, zipCode: zip,
      address: [address, number, complement, neighborhood].filter(Boolean).join(', '),
      addressLines: addressLines([address, number, complement], neighborhood, city?.name, uf, zip),
      email: pick(r.email, c?.financial_email || c?.representative_email), phone: pick(r.phone, c?.financial_contact || c?.representative_contact),
      logoUrl: pick(r.logoUrl, c?.logoUrl), color: r.color,
      municipalRegistration: r.municipalRegistration, stateRegistration: r.stateRegistration,
      brand: r.brand && typeof r.brand === 'object' ? (r.brand as Record<string, unknown>) : null,
    };
  }

  /** Mapa id → nome curto, para as listas mostrarem o CNPJ de cada linha. */
  async names(companyId: number): Promise<Map<number, { tradeName: string; color: string | null; cnpj: string }>> {
    const rows = await this.prisma.company_Entity.findMany({ where: { companyId }, select: { id: true, tradeName: true, color: true, cnpj: true } });
    return new Map(rows.map((r) => [r.id, { tradeName: r.tradeName, color: r.color, cnpj: r.cnpj }]));
  }

  private data(body: Record<string, unknown>, partial: boolean): Prisma.Company_EntityUncheckedUpdateInput {
    const data: Prisma.Company_EntityUncheckedUpdateInput = {};
    if (!partial || 'cnpj' in body) {
      const cnpj = digits(body.cnpj);
      if (!validCnpj(cnpj)) throw new BadRequestException('CNPJ inválido');
      data.cnpj = cnpj;
    }
    if (!partial || 'corporateName' in body) {
      const v = clean(body.corporateName, 255);
      if (!v) throw new BadRequestException('Informe a razão social');
      data.corporateName = v;
    }
    if (!partial || 'tradeName' in body) {
      const v = clean(body.tradeName, 120);
      if (!v) throw new BadRequestException('Dê um nome curto ao CNPJ (ex.: WorkSafe Treinamentos)');
      data.tradeName = v;
    }
    if ('kinds' in body) {
      const kinds = Array.isArray(body.kinds) ? body.kinds.map(String) : [];
      if (kinds.some((k) => !ENTITY_KINDS.includes(k as EntityKind))) throw new BadRequestException('Frente inválida');
      data.kinds = [...new Set(kinds)];
    }
    if ('color' in body) {
      const c = clean(body.color, 7);
      if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) throw new BadRequestException('Cor inválida');
      data.color = c || null;
    }
    const text: Array<[string, number]> = [['logoUrl', 255], ['zipCode', 9], ['address', 255], ['addressNumber', 20], ['addressComplement', 120], ['neighborhood', 120], ['email', 255], ['phone', 30], ['municipalRegistration', 20], ['stateRegistration', 20]];
    for (const [field, max] of text) if (field in body) (data as Record<string, unknown>)[field] = clean(body[field], max) || null;
    for (const field of ['stateId', 'cityId'] as const) {
      if (!(field in body)) continue;
      const n = Number(body[field]);
      data[field] = Number.isInteger(n) && n > 0 ? n : null;
    }
    if ('brand' in body) data.brand = body.brand && typeof body.brand === 'object' ? (body.brand as Prisma.InputJsonValue) : Prisma.DbNull;
    return data;
  }

  async create(actor: EntityActor, body: Record<string, unknown>) {
    const data = this.data(body, false) as Prisma.Company_EntityUncheckedCreateInput;
    const exists = await this.prisma.company_Entity.findFirst({ where: { companyId: actor.companyId, cnpj: data.cnpj } });
    if (exists) throw new ConflictException('Este CNPJ já está cadastrado no grupo');
    const count = await this.prisma.company_Entity.count({ where: { companyId: actor.companyId } });
    const created = await this.prisma.$transaction(async (tx) => {
      const isDefault = count === 0 || !!body.isDefault;
      if (isDefault) await tx.company_Entity.updateMany({ where: { companyId: actor.companyId }, data: { isDefault: false } });
      const created = await tx.company_Entity.create({ data: { ...data, companyId: actor.companyId, isDefault }, include: this.include });
      await this.claimKinds(tx, actor.companyId, created.id, created.kinds);
      return created;
    });
    return this.out(created);
  }

  async update(actor: EntityActor, id: number, body: Record<string, unknown>) {
    const current = await this.get(actor.companyId, id);
    const data = this.data(body, true);
    if (data.cnpj && data.cnpj !== current.cnpj) {
      const used = await this.prisma.fiscal_Invoice.count({ where: { entityId: id, status: { in: ['autorizada', 'cancelada', 'substituida'] } } });
      if (used) throw new ConflictException('Este CNPJ já tem notas fiscais emitidas: não dá para trocar o número. Cadastre um CNPJ novo.');
      const dup = await this.prisma.company_Entity.findFirst({ where: { companyId: actor.companyId, cnpj: String(data.cnpj), id: { not: id } } });
      if (dup) throw new ConflictException('Este CNPJ já está cadastrado no grupo');
    }
    if ('active' in body) {
      if (!body.active && current.isDefault) throw new BadRequestException('Escolha outro CNPJ como padrão antes de desativar este');
      data.inactiveAt = body.active ? null : new Date();
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      if (body.isDefault === true) {
        if (current.inactiveAt && body.active !== true) throw new BadRequestException('Ative o CNPJ antes de torná-lo padrão');
        await tx.company_Entity.updateMany({ where: { companyId: actor.companyId, id: { not: id } }, data: { isDefault: false } });
        data.isDefault = true;
      }
      const saved = await tx.company_Entity.update({ where: { id }, data, include: this.include });
      if ('kinds' in body) await this.claimKinds(tx, actor.companyId, id, saved.kinds);
      return saved;
    });
    return this.out(updated);
  }

  /**
   * Uma frente é de um CNPJ só: quem assume treinamento (por exemplo) tira a
   * frente dos outros, e os registros novos dela passam a nascer nele. Os que
   * já existem mudam só pelo "distribuir".
   */
  private async claimKinds(tx: Prisma.TransactionClient, companyId: number, id: number, kinds: string[]) {
    if (!kinds.length) return;
    const others = await tx.company_Entity.findMany({ where: { companyId, id: { not: id } }, select: { id: true, kinds: true } });
    for (const o of others) {
      const left = o.kinds.filter((k) => !kinds.includes(k));
      if (left.length !== o.kinds.length) await tx.company_Entity.update({ where: { id: o.id }, data: { kinds: left } });
    }
  }

  /** Quantos registros de cada tipo são deste CNPJ (a tela mostra antes de distribuir). */
  async usage(companyId: number, id: number) {
    await this.get(companyId, id);
    const db = this.prisma as unknown as Record<string, { count: (args: unknown) => Promise<number> }>;
    const counts = await Promise.all(USAGE.map((u) => db[u.model].count({ where: { companyId, entityId: id } })));
    return USAGE.map((u, i) => ({ key: u.key, label: u.label, count: counts[i] }));
  }

  /**
   * Distribuir: passa para este CNPJ tudo o que é de uma frente (treinamento,
   * serviço ou locação), com o que nasceu disso (contratos, OS, OL, turmas,
   * contas a receber e a pagar ligadas). Notas fiscais já emitidas não mudam:
   * foram emitidas por um CNPJ e continuam dele. Com `preview`, só conta.
   */
  async assign(actor: EntityActor, id: number, body: Record<string, unknown>) {
    const target = await this.get(actor.companyId, id);
    if (target.inactiveAt) throw new BadRequestException('Ative o CNPJ antes de distribuir registros para ele');
    const scope = String(body.scope ?? '') as EntityKind;
    if (!ENTITY_KINDS.includes(scope)) throw new BadRequestException('Escolha a frente: treinamento, serviço ou locação');
    const preview = !!body.preview;
    const companyId = actor.companyId;
    const other = { companyId, OR: [{ entityId: null }, { entityId: { not: id } }] };

    return this.prisma.$transaction(async (tx) => {
      const proposals = await tx.commercial_Proposal.findMany({ where: { ...other, kind: scope }, select: { id: true } });
      const contracts = await tx.commercial_Contract.findMany({ where: { ...other, kind: scope }, select: { id: true } });
      const contractIds = contracts.map((c) => c.id);
      const courses = scope === 'treinamento' ? await tx.course.findMany({ where: other, select: { id: true } }) : [];
      const classes = scope === 'treinamento' ? await tx.courseClass.findMany({ where: other, select: { id: true } }) : [];
      const orders = scope === 'servico' ? await tx.service_Order.findMany({ where: other, select: { id: true } }) : [];
      const rentals = scope === 'locacao' ? await tx.stock_Rental.findMany({ where: other, select: { id: true } }) : [];
      const classIds = classes.map((c) => c.id);
      const subscriptionIds = classIds.length ? (await tx.courseClassSubscription.findMany({ where: { classId: { in: classIds } }, select: { id: true } })).map((s) => s.id) : [];
      const receivableWhere: Prisma.FinancialRecordsWhereInput = {
        ...other,
        OR: [
          ...(contractIds.length ? [{ contractId: { in: contractIds } }] : []),
          ...(subscriptionIds.length ? [{ subscriptionId: { in: subscriptionIds } }] : []),
        ],
      };
      const receivables = receivableWhere.OR!.length ? await tx.financialRecords.findMany({ where: { companyId, AND: [{ OR: [{ entityId: null }, { entityId: { not: id } }] }, { OR: receivableWhere.OR }] }, select: { id: true } }) : [];
      const orderIds = orders.map((o) => o.id);
      const purchaseWhere: Prisma.Purchase_OrderWhereInput[] = [
        ...(orderIds.length ? [{ serviceOrderId: { in: orderIds } }] : []),
        ...(rentals.length ? [{ rentalId: { in: rentals.map((r) => r.id) } }] : []),
        ...(classIds.length ? [{ classId: { in: classIds } }] : []),
      ];
      const purchaseIds = purchaseWhere.length ? (await tx.purchase_Order.findMany({ where: { companyId, OR: purchaseWhere }, select: { id: true } })).map((p) => p.id) : [];
      const payableOr: Prisma.Financial_PayableWhereInput[] = [
        ...(orderIds.length ? [{ serviceOrderId: { in: orderIds } }] : []),
        ...(purchaseIds.length ? [{ purchaseOrderId: { in: purchaseIds } }] : []),
      ];
      const payables = payableOr.length ? await tx.financial_Payable.findMany({ where: { companyId, AND: [{ OR: [{ entityId: null }, { entityId: { not: id } }] }, { OR: payableOr }] }, select: { id: true } }) : [];

      const result = [
        { key: 'proposals', label: 'Propostas', count: proposals.length },
        { key: 'contracts', label: 'Contratos', count: contracts.length },
        { key: 'courses', label: 'Cursos', count: courses.length },
        { key: 'classes', label: 'Turmas', count: classes.length },
        { key: 'serviceOrders', label: 'Ordens de serviço', count: orders.length },
        { key: 'rentals', label: 'Ordens de locação', count: rentals.length },
        { key: 'receivables', label: 'Contas a receber', count: receivables.length },
        { key: 'payables', label: 'Contas a pagar', count: payables.length },
      ].filter((r) => r.count > 0 || ['proposals', 'contracts'].includes(r.key));
      if (preview) return { preview: true, scope, items: result };

      const ids = (rows: Array<{ id: number }>) => ({ id: { in: rows.map((r) => r.id) } });
      const set = { entityId: id };
      if (proposals.length) await tx.commercial_Proposal.updateMany({ where: ids(proposals), data: set });
      if (contracts.length) await tx.commercial_Contract.updateMany({ where: ids(contracts), data: set });
      if (courses.length) await tx.course.updateMany({ where: ids(courses), data: set });
      if (classes.length) await tx.courseClass.updateMany({ where: ids(classes), data: set });
      if (orders.length) await tx.service_Order.updateMany({ where: ids(orders), data: set });
      if (rentals.length) await tx.stock_Rental.updateMany({ where: ids(rentals), data: set });
      if (receivables.length) await tx.financialRecords.updateMany({ where: ids(receivables), data: set });
      if (payables.length) await tx.financial_Payable.updateMany({ where: ids(payables), data: set });
      // a frente passa a ser deste CNPJ (os novos registros já nascem nele)
      const kinds = new Set(target.kinds);
      kinds.add(scope);
      await tx.company_Entity.update({ where: { id }, data: { kinds: [...kinds] } });
      const others = await tx.company_Entity.findMany({ where: { companyId, id: { not: id } }, select: { id: true, kinds: true } });
      for (const o of others) if (o.kinds.includes(scope)) await tx.company_Entity.update({ where: { id: o.id }, data: { kinds: o.kinds.filter((k) => k !== scope) } });
      return { preview: false, scope, items: result };
    }, { timeout: 60_000 });
  }
}
