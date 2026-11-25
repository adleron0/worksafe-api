import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, paymentMethods } from '@prisma/client';
import { PrivateStorageService } from 'src/common/storage/private-storage.service';
import { EmailService } from 'src/features/email/email.service';
import { classificationDefaults } from 'src/features/financial/classification';
import { RetentionTax, writeRetentions } from 'src/features/financial/retention.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { renderDanfse } from './danfse';
import { buildCancelEvent, buildDps, DpsInput } from './dps.builder';
import { cityOfIbge, clean, digits, ibgeOf, isCnpj, isCpf, round2, todayBr, toNumber } from './fiscal.utils';
import { brl, calcInvoice, CalcResult, FEDERAL_TAXES, FederalTax, fillTemplate, RetentionField } from './invoice.calc';
import { parseEventXml, parseNfseXml } from './nfse-xml';
import { SefinClient, SefinMessage, SefinResult, SefinTransportError } from './sefin.client';
import { FiscalActor, FiscalSettingsService } from './settings.service';
import { signXml } from './xml-signer';

type Tx = Prisma.TransactionClient;
type InvoiceRow = Prisma.Fiscal_InvoiceGetPayload<{ include: { links: true; events: true } }>;

export interface TakerSnapshot {
  kind: 'cliente' | 'aluno' | 'avulso';
  document: string;
  name: string;
  municipalRegistration?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: { ibge: string | null; cityName?: string | null; uf?: string | null; cep: string; street: string; number: string; complement?: string | null; district: string } | null;
}

export interface ServiceSnapshot {
  serviceCodeId: number | null;
  name: string | null;
  nationalCode: string;
  nationalLabel?: string | null;
  municipalCode?: string | null;
  nbsCode?: string | null;
  issTaxation: number;
}

interface ExtraData {
  retentions?: Partial<Record<FederalTax, RetentionField>>;
  reference?: string | null; // documento de referência (proposta, contrato)
  order?: string | null; // pedido do cliente
  notes?: string | null; // informações complementares
  calc?: Pick<CalcResult, 'base' | 'federal' | 'retainedTotal' | 'lines'>;
}

const STATUS_LABEL: Record<string, string> = {
  rascunho: 'Rascunho', emitindo: 'Enviando', autorizada: 'Autorizada', rejeitada: 'Rejeitada', cancelada: 'Cancelada', substituida: 'Substituída',
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const dateOnly = (value: unknown): string | null => {
  const text = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
};
const noonUtc = (date: string) => new Date(`${date}T15:00:00.000Z`);

/** Mensagem de rejeição do ambiente nacional em português claro (o texto oficial já vem em português; aqui só o código na frente). */
export function friendlyMessages(list: SefinMessage[]): Array<{ code: string; message: string }> {
  return list.map((m) => ({ code: m.code, message: [m.description, m.complement].filter(Boolean).join(' — ') || 'Rejeição sem descrição' }));
}

/**
 * Notas fiscais de serviço: rascunho, prévia, emissão pela Sefin Nacional,
 * conferência de envio interrompido, cancelamento, substituição, PDF e e-mail.
 *
 * A nota é separada da cobrança: pode gerar uma conta a receber ao ser
 * autorizada (nota avulsa) ou ser vinculada depois aos fluxos (parcela,
 * medição, locação, inscrição) pelas tabelas de vínculo.
 */
@Injectable()
export class FiscalInvoiceService {
  private readonly logger = new Logger(FiscalInvoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: FiscalSettingsService,
    private readonly storage: PrivateStorageService,
    private readonly email: EmailService,
  ) {}

  // ------------------------------------------------------------------ tomador e serviço

  private async takerFrom(companyId: number, body: Record<string, unknown>): Promise<{ snapshot: TakerSnapshot; customerId: number | null; traineeId: number | null }> {
    const kind = (['cliente', 'aluno', 'avulso'].includes(String(body.takerKind)) ? body.takerKind : body.customerId ? 'cliente' : body.traineeId ? 'aluno' : 'avulso') as TakerSnapshot['kind'];
    const over = (body.taker ?? {}) as Partial<TakerSnapshot> & { address?: Partial<NonNullable<TakerSnapshot['address']>> | null };
    let base: TakerSnapshot = { kind, document: '', name: '' };
    let customerId: number | null = null;
    let traineeId: number | null = null;

    if (kind === 'cliente') {
      customerId = Number(body.customerId) || null;
      if (!customerId) throw new BadRequestException('Escolha o cliente da nota');
      const c = await this.prisma.customer.findFirst({
        where: { id: customerId, companyId },
        include: { city: true, state: true, contacts: { where: { inactiveAt: null, isFiscal: true }, orderBy: [{ defaultFiscal: 'desc' }, { id: 'asc' }], take: 1 } },
      });
      if (!c) throw new NotFoundException('Cliente não encontrado');
      base = {
        kind,
        document: digits(c.cnpj),
        name: c.corporateName || c.name,
        municipalRegistration: c.municipalRegistration,
        email: c.contacts[0]?.email || c.email,
        phone: c.contacts[0]?.phone || c.phone,
        address: {
          ibge: c.city ? ibgeOf(c.city.name, c.state?.uf) : null,
          cityName: c.city?.name ?? null,
          uf: c.state?.uf ?? null,
          cep: digits(c.zipcode),
          street: c.street ?? '',
          number: c.number ? String(c.number) : '',
          complement: c.complement,
          district: c.neighborhood ?? '',
        },
      };
    } else if (kind === 'aluno') {
      traineeId = Number(body.traineeId) || null;
      if (!traineeId) throw new BadRequestException('Escolha o aluno da nota');
      const t = await this.prisma.trainee.findFirst({ where: { id: traineeId }, include: { city: true, state: true } });
      if (!t) throw new NotFoundException('Aluno não encontrado');
      base = {
        kind,
        document: digits(t.cpf),
        name: t.name,
        email: t.email,
        phone: t.phone,
        address: t.address ? { ibge: t.city ? ibgeOf(t.city.name, t.state?.uf) : null, cityName: t.city?.name ?? null, uf: t.state?.uf ?? null, cep: digits(t.zipCode), street: t.address, number: t.addressNumber ?? '', complement: t.complement, district: '' } : null,
      };
    }

    // o que foi digitado na tela vale mais que o cadastro (corrigir sem sair da nota)
    const snapshot: TakerSnapshot = {
      ...base,
      document: over.document !== undefined ? digits(over.document) : base.document,
      name: over.name !== undefined ? clean(over.name, 300) : base.name,
      municipalRegistration: over.municipalRegistration !== undefined ? clean(over.municipalRegistration, 15) || null : base.municipalRegistration ?? null,
      email: over.email !== undefined ? clean(over.email, 80) || null : base.email ?? null,
      phone: over.phone !== undefined ? digits(over.phone) || null : base.phone ?? null,
    };
    if (over.address === null) snapshot.address = null;
    else if (over.address || base.address) {
      const a = { ...(base.address ?? { ibge: null, cep: '', street: '', number: '', district: '' }), ...(over.address ?? {}) };
      const ibge = digits(a.ibge) || (a.cityName ? ibgeOf(a.cityName, a.uf) : null);
      snapshot.address = { ibge: ibge || null, cityName: a.cityName ?? null, uf: a.uf ?? null, cep: digits(a.cep), street: clean(a.street, 255), number: clean(a.number, 60), complement: clean(a.complement, 156) || null, district: clean(a.district, 60) };
    }
    return { snapshot, customerId, traineeId };
  }

  private async serviceFrom(companyId: number, body: Record<string, unknown>): Promise<{ snapshot: ServiceSnapshot; defaultDescription: string | null; issRate: number | null }> {
    const id = Number(body.serviceCodeId) || null;
    if (id) {
      const row = await this.prisma.fiscal_ServiceCode.findFirst({ where: { id, companyId } });
      if (!row) throw new NotFoundException('Serviço fiscal não encontrado');
      const out = this.settings.serviceCodeOut(row);
      return {
        snapshot: { serviceCodeId: row.id, name: row.name, nationalCode: row.nationalCode, nationalLabel: out.nationalLabel, municipalCode: row.municipalCode, nbsCode: row.nbsCode, issTaxation: row.issTaxation },
        defaultDescription: row.description,
        issRate: row.issRate === null ? null : Number(row.issRate),
      };
    }
    const code = digits(body.nationalCode);
    if (!code) throw new BadRequestException('Escolha o serviço fiscal da nota');
    return { snapshot: { serviceCodeId: null, name: null, nationalCode: code.padStart(6, '0'), nbsCode: digits(body.nbsCode) || null, issTaxation: Number(body.issTaxation) || 1 }, defaultDescription: null, issRate: null };
  }

  // ------------------------------------------------------------------ prévia e validação

  /** Monta a nota a partir do que veio da tela, sem gravar: valores, retenções, discriminação, erros e avisos. */
  async build(companyId: number, body: Record<string, unknown>) {
    const [settings, emitter] = await Promise.all([this.settings.settingsRow(companyId), this.settings.emitter(companyId)]);
    const taker = await this.takerFrom(companyId, body);
    const service = await this.serviceFrom(companyId, body);
    const retentions = (body.retentions ?? {}) as Partial<Record<FederalTax, RetentionField>>;
    const issWithheld = !!body.issWithheld;
    const typedRate = body.issRate === undefined || body.issRate === '' ? undefined : body.issRate === null ? null : toNumber(body.issRate);
    const issRate = typedRate !== undefined ? typedRate : service.issRate;
    const calc = calcInvoice({ gross: toNumber(body.grossValue), discount: toNumber(body.discountValue), issRate, issWithheld, retentions });
    const competence = dateOnly(body.competence) ?? todayBr();
    // local da prestação: código IBGE, ou cidade e UF digitadas; sem nada, a sede da empresa
    const placeOfService = digits(body.placeOfService) || (body.placeCity ? ibgeOf(body.placeCity, body.placeUf) : null) || (body.placeCity ? '' : emitter.ibge) || '';
    const vars = {
      cliente: taker.snapshot.name,
      competencia: competence.slice(0, 7).split('-').reverse().join('/'),
      valor: brl(calc.gross),
      liquido: brl(calc.net),
      pedido: clean(body.order) || null,
      referencia: clean(body.reference) || null,
    };
    const typedDescription = String(body.description ?? '').trim();
    const description = typedDescription || fillTemplate(service.defaultDescription ?? '', vars);
    const notesTemplate = body.notes !== undefined ? String(body.notes ?? '') : settings.defaultNotes ?? '';
    const notes = fillTemplate(notesTemplate, vars) || null;

    const errors = [...calc.errors];
    const warnings: string[] = [];
    const t = taker.snapshot;
    if (!t.document || (!isCpf(t.document) && !isCnpj(t.document))) errors.push('O tomador precisa de CPF ou CNPJ válido.');
    if (!t.name) errors.push('Informe o nome do tomador.');
    const addressOk = !!t.address && !!t.address.ibge && t.address.cep.length === 8 && !!t.address.street && !!t.address.district;
    if (isCnpj(t.document) && !addressOk) errors.push('Tomador com CNPJ precisa de endereço completo (rua, bairro, CEP e cidade).');
    if (isCpf(t.document) && issWithheld && !addressOk) errors.push('Com ISS retido, o tomador precisa de endereço completo.');
    if (t.address && !t.address.ibge && t.address.street) errors.push('Não achei o código IBGE da cidade do tomador. Confira a cidade no cadastro.');
    if (digits(t.document) === emitter.cnpj) errors.push('O tomador não pode ser a própria empresa.');
    if (!description) errors.push('Escreva a discriminação do serviço.');
    if (!placeOfService) errors.push(body.placeCity ? 'Não achei o código IBGE da cidade da prestação. Confira o nome e a UF.' : 'Informe o município onde o serviço foi prestado.');
    if (competence > todayBr()) errors.push('A competência não pode ser depois de hoje.');
    if (!emitter.ibge) errors.push('A cidade da empresa não está cadastrada (o código IBGE sai dela).');
    // ME/EPP com ISS pelo Simples: a alíquota só vai na nota quando o cliente retém (E0625 × E0621)
    if (settings.simplesNacional === 3 && !issWithheld && issRate) warnings.push('No Simples, a alíquota do ISS só vai na nota quando o cliente retém. Ela foi deixada de fora.');
    if (settings.simplesNacional === 3 && issWithheld && issRate !== null && issRate < 2) warnings.push('A alíquota do ISS retido costuma ser de pelo menos 2%. Confira.');
    if (settings.environment === 'restrita') warnings.push('Ambiente de testes (produção restrita): a nota não tem valor fiscal.');
    if (calc.federal.csll.value === 0 && (calc.federal.pis.value > 0 || calc.federal.cofins.value > 0)) warnings.push('PIS/COFINS retidos sem CSLL: confira com o contador se o cliente também retém a CSLL.');

    const receivableIn = body.receivable as { create?: boolean; dueDate?: string; description?: string; paymentMethod?: string } | undefined;
    const receivable = receivableIn?.create ? { dueDate: dateOnly(receivableIn.dueDate) ?? competence, description: clean(receivableIn.description, 255) || null, paymentMethod: receivableIn.paymentMethod ?? 'boleto' } : null;
    if (receivable && receivable.dueDate < competence) warnings.push('O vencimento da conta a receber é antes da competência da nota.');

    return {
      taker: t,
      customerId: taker.customerId,
      traineeId: taker.traineeId,
      service: service.snapshot,
      description,
      notes,
      placeOfService,
      competence,
      calc,
      issRateForXml: settings.simplesNacional === 3 && !issWithheld ? null : calc.issRate,
      extra: { retentions, reference: clean(body.reference, 255) || null, order: clean(body.order, 60) || null, notes, calc: { base: calc.base, federal: calc.federal, retainedTotal: calc.retainedTotal, lines: calc.lines } } as ExtraData,
      receivable,
      environment: settings.environment,
      errors,
      warnings,
    };
  }

  async preview(companyId: number, body: Record<string, unknown>) {
    const built = await this.build(companyId, body);
    const { extra, ...rest } = built;
    const place = built.placeOfService ? cityOfIbge(built.placeOfService) : null;
    return { ...rest, placeLabel: place ? `${place.name}/${place.uf}` : null, reference: extra.reference, order: extra.order, canEmit: built.errors.length === 0 };
  }

  private dataOf(built: Awaited<ReturnType<FiscalInvoiceService['build']>>) {
    return {
      takerKind: built.taker.kind,
      customerId: built.customerId,
      traineeId: built.traineeId,
      taker: built.taker as unknown as Prisma.InputJsonValue,
      serviceCodeId: built.service.serviceCodeId,
      service: { ...built.service, extra: built.extra } as unknown as Prisma.InputJsonValue,
      description: built.description,
      placeOfService: built.placeOfService,
      competence: new Date(`${built.competence}T00:00:00.000Z`),
      grossValue: built.calc.gross,
      discountValue: built.calc.discount,
      issRate: built.calc.issRate,
      issValue: built.calc.issValue,
      issWithheld: built.calc.issWithheld,
      federalRetentions: Object.fromEntries(FEDERAL_TAXES.map((t) => [t, built.calc.federal[t].value])) as Prisma.InputJsonValue,
      netValue: built.calc.net,
      receivable: (built.receivable ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      environment: built.environment,
    };
  }

  // ------------------------------------------------------------------ rascunho

  async create(actor: FiscalActor, body: Record<string, unknown>) {
    const built = await this.build(actor.companyId, body);
    let replaces: { id: number } | null = null;
    if (body.replacesId) {
      replaces = await this.prisma.fiscal_Invoice.findFirst({ where: { id: Number(body.replacesId), companyId: actor.companyId, status: 'autorizada', provider: 'sefin' }, select: { id: true } });
      if (!replaces) throw new BadRequestException('Só uma nota autorizada pode ser substituída');
    }
    const created = await this.prisma.fiscal_Invoice.create({
      data: { ...this.dataOf(built), companyId: actor.companyId, status: 'rascunho', createdByUserId: actor.userId, replacesId: replaces?.id ?? null },
    });
    if (body.emit) return this.emit(actor, created.id);
    return this.get(actor.companyId, created.id);
  }

  async update(actor: FiscalActor, id: number, body: Record<string, unknown>) {
    const found = await this.row(actor.companyId, id);
    if (!['rascunho', 'rejeitada'].includes(found.status)) throw new BadRequestException('Só dá para alterar rascunho ou nota rejeitada');
    const built = await this.build(actor.companyId, body);
    // a numeração reservada fica: reenviar com o mesmo número é seguro (Id igual)
    const data = this.dataOf(built);
    if (found.dpsNumber && found.environment !== built.environment) Object.assign(data, { dpsNumber: null, dpsSeries: null, dpsId: null });
    await this.prisma.fiscal_Invoice.update({ where: { id }, data: { ...data, status: 'rascunho', messages: Prisma.JsonNull } });
    if (body.emit) return this.emit(actor, id);
    return this.get(actor.companyId, id);
  }

  async remove(actor: FiscalActor, id: number) {
    const found = await this.row(actor.companyId, id);
    if (!['rascunho', 'rejeitada'].includes(found.status)) throw new BadRequestException('Só rascunho ou nota rejeitada pode ser excluída');
    if (found.dpsNumber) {
      // número já reservado: pode ter chegado ao ambiente nacional; só exclui se lá não existe
      const exists = await this.dpsExists(actor.companyId, found).catch(() => null);
      if (exists !== false) throw new BadRequestException('Esta nota já foi enviada uma vez. Use "Conferir no ambiente nacional" antes de excluir.');
    }
    await this.prisma.fiscal_Invoice.delete({ where: { id } });
    return { ok: true };
  }

  /** Nota emitida fora do sistema: só o registro (número, data, arquivo), para entrar nos vínculos e no saldo. */
  async registerExternal(actor: FiscalActor, body: Record<string, unknown>) {
    const number = clean(body.number, 20);
    if (!number) throw new BadRequestException('Informe o número da nota');
    const issuedAt = dateOnly(body.issuedAt) ?? todayBr();
    const built = await this.build(actor.companyId, { ...body, description: body.description || `Nota ${number} emitida fora do sistema` });
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.fiscal_Invoice.create({
        data: {
          ...this.dataOf(built), companyId: actor.companyId, provider: 'externa', status: 'autorizada', environment: 'producao',
          number, issuedAt: noonUtc(issuedAt), externalUrl: clean(body.externalUrl) || null, accessKey: digits(body.accessKey).length === 50 ? digits(body.accessKey) : null,
          createdByUserId: actor.userId, issuedByUserId: actor.userId,
        },
      });
      await tx.fiscal_InvoiceEvent.create({ data: { invoiceId: row.id, kind: 'emitida', detail: { externa: true }, userId: actor.userId } });
      await this.createReceivable(tx, actor, row.id);
      return row;
    });
    return this.get(actor.companyId, created.id);
  }

  // ------------------------------------------------------------------ emissão

  private async client(companyId: number, environment: 'restrita' | 'producao') {
    const cert = await this.settings.certificate(companyId);
    return { cert, client: new SefinClient(environment, cert) };
  }

  private async dpsExists(companyId: number, row: { environment: 'restrita' | 'producao'; dpsId: string | null }) {
    if (!row.dpsId) return false;
    const { client } = await this.client(companyId, row.environment);
    return client.dpsExists(row.dpsId);
  }

  /** Reserva série e número da DPS (atômico: o incremento trava a linha da configuração). */
  private async reserveNumber(tx: Tx, companyId: number, environment: 'restrita' | 'producao') {
    const field = environment === 'producao' ? 'nextDpsNumber' : 'nextDpsNumberTest';
    const updated = await tx.fiscal_Settings.update({ where: { companyId }, data: { [field]: { increment: 1 } } });
    return { series: updated.dpsSeries, number: updated[field] - 1 };
  }

  private dpsInputOf(row: InvoiceRow, settings: Awaited<ReturnType<FiscalSettingsService['settingsRow']>>, emitterIbge: string, emitterCnpj: string, replaces: { accessKey: string } | null): DpsInput {
    const taker = row.taker as unknown as TakerSnapshot;
    const service = row.service as unknown as ServiceSnapshot & { extra?: ExtraData };
    const extra = service.extra ?? {};
    const calc = calcInvoice({ gross: Number(row.grossValue), discount: Number(row.discountValue), issRate: row.issRate === null ? null : Number(row.issRate), issWithheld: row.issWithheld, retentions: extra.retentions });
    const a = taker.address;
    return {
      environment: row.environment,
      // alguns segundos antes: dhEmi não pode passar do horário de processamento (E0008)
      issuedAt: new Date(Date.now() - 60_000),
      series: row.dpsSeries!,
      number: row.dpsNumber!,
      competence: row.competence.toISOString().slice(0, 10),
      emitterIbge,
      provider: { cnpj: emitterCnpj, municipalRegistration: settings.municipalRegistration, simplesNacional: settings.simplesNacional, simplesRegime: settings.simplesRegime, specialRegime: settings.specialRegime },
      taker: {
        document: taker.document,
        name: taker.name,
        municipalRegistration: taker.municipalRegistration,
        email: taker.email,
        phone: taker.phone,
        address: a && a.ibge && a.cep && a.street && a.district ? { ibge: a.ibge, cep: a.cep, street: a.street, number: a.number, complement: a.complement, district: a.district } : null,
      },
      service: { placeIbge: row.placeOfService, nationalCode: service.nationalCode, municipalCode: service.municipalCode, description: row.description, nbs: service.nbsCode },
      info: { reference: extra.reference, order: extra.order, notes: extra.notes },
      values: {
        gross: calc.gross,
        unconditionalDiscount: calc.discount,
        issTaxation: service.issTaxation || 1,
        issWithheld: calc.issWithheld,
        issRate: settings.simplesNacional === 3 && !calc.issWithheld ? null : calc.issRate,
        federal: {
          inss: calc.federal.inss.value, ir: calc.federal.ir.value, csll: calc.federal.csll.value,
          pisRate: calc.federal.pis.value > 0 ? calc.federal.pis.rate ?? 0 : 0, cofinsRate: calc.federal.cofins.value > 0 ? calc.federal.cofins.rate ?? 0 : 0,
          pisCofinsCst: settings.pisCofinsCst,
        },
        simplesTotalRate: settings.simplesTotalRate === null ? null : Number(settings.simplesTotalRate),
      },
      substitutes: replaces ? { accessKey: replaces.accessKey, reason: '99', description: 'Substituição de NFS-e emitida pelo WorkSafe' } : null,
    };
  }

  /** Emite a nota: reserva o número, monta e assina a DPS, envia e grava o resultado. */
  async emit(actor: FiscalActor, id: number) {
    const row = await this.row(actor.companyId, id);
    if (row.provider !== 'sefin') throw new BadRequestException('Esta nota foi emitida fora do sistema');
    if (row.status === 'autorizada') return this.get(actor.companyId, id);
    if (row.status === 'emitindo') return this.check(actor, id);
    if (!['rascunho', 'rejeitada'].includes(row.status)) throw new BadRequestException(`Nota ${STATUS_LABEL[row.status].toLowerCase()} não pode ser emitida`);

    const [settingsInfo, settings, emitter] = await Promise.all([this.settings.get(actor.companyId), this.settings.settingsRow(actor.companyId), this.settings.emitter(actor.companyId)]);
    if (!settingsInfo.ready) throw new BadRequestException(`Antes de emitir: ${settingsInfo.pending.join(' ')}`);
    // revalida com o cadastro de agora (tomador e serviço podem ter mudado)
    const rebuilt = await this.build(actor.companyId, this.bodyOf(row));
    if (rebuilt.errors.length) throw new BadRequestException(rebuilt.errors.join(' '));
    const { cert, client } = await this.client(actor.companyId, settings.environment);

    let replaces: { accessKey: string } | null = null;
    if (row.replacesId) {
      const old = await this.prisma.fiscal_Invoice.findFirst({ where: { id: row.replacesId, companyId: actor.companyId } });
      if (!old?.accessKey || old.status !== 'autorizada') throw new BadRequestException('A nota a substituir não está mais autorizada');
      replaces = { accessKey: old.accessKey };
    }

    const reserved = await this.prisma.$transaction(async (tx) => {
      let series = row.dpsSeries;
      let number = row.dpsNumber;
      if (!number || row.environment !== settings.environment) ({ series, number } = await this.reserveNumber(tx, actor.companyId, settings.environment));
      const fresh = await tx.fiscal_Invoice.update({
        where: { id },
        data: { ...this.dataOf(rebuilt), status: 'emitindo', environment: settings.environment, dpsSeries: series, dpsNumber: number, sentAt: new Date(), issuedByUserId: actor.userId, messages: Prisma.JsonNull },
        include: { links: true, events: true },
      });
      return fresh;
    });

    const input = this.dpsInputOf(reserved, settings, emitter.ibge!, emitter.cnpj, replaces);
    const dps = buildDps(input);
    await this.prisma.fiscal_Invoice.update({ where: { id }, data: { dpsId: dps.id } });
    const signed = signXml(dps.xml, 'infDPS', cert.privateKeyPem, cert.certificatePem);

    let result: SefinResult;
    try {
      result = await client.emit(signed);
    } catch (error) {
      const message = error instanceof SefinTransportError ? error.message : 'Falha de conexão';
      await this.prisma.fiscal_InvoiceEvent.create({ data: { invoiceId: id, kind: 'conferida', detail: { erro: message }, userId: actor.userId } });
      await this.prisma.fiscal_Invoice.update({ where: { id }, data: { messages: [{ code: 'conexao', message: `${message}. A nota pode ter sido gerada: use "Conferir no ambiente nacional" antes de enviar de novo.` }] } });
      return this.get(actor.companyId, id);
    }

    if (result.ok && result.xml) return this.finalize(actor, id, result.xml, result.alerts);
    // DPS com este número já virou nota (reenvio): busca a nota em vez de rejeitar
    if (result.errors.some((e) => e.code === 'E0014')) return this.check(actor, id);
    await this.prisma.$transaction([
      this.prisma.fiscal_Invoice.update({ where: { id }, data: { status: 'rejeitada', messages: friendlyMessages(result.errors) as unknown as Prisma.InputJsonValue } }),
      this.prisma.fiscal_InvoiceEvent.create({ data: { invoiceId: id, kind: 'rejeitada', detail: { status: result.status, erros: friendlyMessages(result.errors) } as unknown as Prisma.InputJsonValue, userId: actor.userId } }),
    ]);
    return this.get(actor.companyId, id);
  }

  /** Envio interrompido: pergunta ao ambiente nacional se a DPS virou nota e, se virou, baixa e grava. */
  async check(actor: FiscalActor, id: number) {
    const row = await this.row(actor.companyId, id);
    if (row.provider !== 'sefin' || !row.dpsId) throw new BadRequestException('Esta nota ainda não foi enviada');
    if (row.status === 'autorizada') return this.get(actor.companyId, id);
    const { client } = await this.client(actor.companyId, row.environment);
    let found: SefinResult;
    try {
      found = await client.getDps(row.dpsId);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Sem resposta do ambiente nacional');
    }
    if (found.ok && found.accessKey) {
      const nfse = await client.getNfse(found.accessKey);
      if (nfse.ok && nfse.xml) return this.finalize(actor, id, nfse.xml, []);
    }
    if (found.status === 404) {
      await this.prisma.$transaction([
        this.prisma.fiscal_Invoice.update({ where: { id }, data: { status: 'rascunho', messages: [{ code: 'nao-gerada', message: 'O ambiente nacional não recebeu esta nota. Pode enviar de novo (o mesmo número será usado).' }] } }),
        this.prisma.fiscal_InvoiceEvent.create({ data: { invoiceId: id, kind: 'conferida', detail: { gerada: false }, userId: actor.userId } }),
      ]);
      return this.get(actor.companyId, id);
    }
    throw new BadRequestException(friendlyMessages(found.errors).map((m) => m.message).join(' ') || 'Não foi possível conferir agora');
  }

  /** Nota autorizada: guarda o XML, preenche número e chave, gera a conta a receber e manda o e-mail. */
  private async finalize(actor: FiscalActor, id: number, xml: string, alerts: SefinMessage[]) {
    const parsed = parseNfseXml(xml);
    const row = await this.row(actor.companyId, id);
    const key = `fiscal/${actor.companyId}/nfse-${id}-${parsed.accessKey ?? row.dpsId}.xml`;
    await this.storage.put(key, Buffer.from(xml, 'utf8'), 'application/xml');
    await this.prisma.$transaction(async (tx) => {
      await tx.fiscal_Invoice.update({
        where: { id },
        data: {
          status: 'autorizada', xmlKey: key, accessKey: parsed.accessKey ?? null, number: parsed.number ?? null,
          issuedAt: parsed.processedAt ? new Date(parsed.processedAt) : new Date(),
          messages: alerts.length ? (friendlyMessages(alerts) as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        },
      });
      await tx.fiscal_InvoiceEvent.create({ data: { invoiceId: id, kind: 'emitida', detail: { numero: parsed.number, chave: parsed.accessKey }, xmlKey: key, userId: actor.userId } });
      if (row.replacesId) await this.applyReplacement(tx, actor, row.replacesId, id);
      await this.createReceivable(tx, actor, id);
    });
    const settings = await this.settings.settingsRow(actor.companyId);
    if (settings.autoSendEmail) {
      await this.send(actor, id, {}).catch((error) => this.logger.warn(`E-mail da NFS-e ${id} não enviado: ${error instanceof Error ? error.message : error}`));
    }
    return this.get(actor.companyId, id);
  }

  /** A nota nova assume os vínculos e as contas da antiga, que vira "substituída". */
  private async applyReplacement(tx: Tx, actor: FiscalActor, oldId: number, newId: number) {
    const fresh = await tx.fiscal_Invoice.findUnique({ where: { id: newId } });
    await tx.fiscal_Invoice.update({ where: { id: oldId }, data: { status: 'substituida', replacedById: newId } });
    await tx.fiscal_InvoiceLink.updateMany({ where: { invoiceId: oldId }, data: { invoiceId: newId } });
    await tx.financialRecords.updateMany({ where: { fiscalInvoiceId: oldId, companyId: actor.companyId }, data: { fiscalInvoiceId: newId, invoiceNumber: fresh?.number ?? null, invoiceIssuedAt: fresh?.issuedAt ?? null } });
    await tx.financial_Retention.updateMany({ where: { fiscalInvoiceId: oldId, companyId: actor.companyId }, data: { fiscalInvoiceId: newId, invoiceNumber: fresh?.number ?? null } });
    // a substituta já nasce com as contas da antiga: não gera outra
    await tx.fiscal_Invoice.update({ where: { id: newId }, data: { receivable: Prisma.JsonNull } });
    await tx.fiscal_InvoiceEvent.create({ data: { invoiceId: oldId, kind: 'substituida', detail: { por: newId }, userId: actor.userId } });
  }

  /** Conta a receber pedida na nota (nota avulsa): líquido = valor − retenções, retenções no relatório. */
  private async createReceivable(tx: Tx, actor: FiscalActor, id: number) {
    const row = await tx.fiscal_Invoice.findUnique({ where: { id } });
    const plan = row?.receivable as { dueDate?: string; description?: string | null; paymentMethod?: string } | null;
    if (!row || !plan?.dueDate) return;
    const extra = ((row.service as unknown as { extra?: ExtraData }).extra ?? {}) as ExtraData;
    const taker = row.taker as unknown as TakerSnapshot;
    const base = round2(Number(row.grossValue) - Number(row.discountValue));
    const accrualDate = row.competence.toISOString().slice(0, 7);
    const method = (['boleto', 'pix', 'transferencia', 'dinheiro', 'outro', 'cartaoCredito'].includes(String(plan.paymentMethod)) ? plan.paymentMethod : 'boleto') as paymentMethods;
    const record = await tx.financialRecords.create({
      data: {
        companyId: actor.companyId, gateway: 'manual', status: 'waiting', paymentMethod: method,
        customerId: row.customerId, traineeId: row.traineeId, value: base, netValue: Number(row.netValue),
        dueDate: noonUtc(plan.dueDate), accrualDate,
        invoiceNumber: row.number, invoiceIssuedAt: row.issuedAt, fiscalInvoiceId: row.id,
        description: (plan.description || `NFS-e ${row.number ?? ''} · ${taker.name}`).slice(0, 255),
        ...(await classificationDefaults(tx, actor.companyId, 'manual')),
      },
    });
    const lines = (extra.calc?.lines ?? []).map((l) => ({ tax: l.tax as RetentionTax, rate: l.rate, value: l.value }));
    await writeRetentions(tx, { id: record.id, companyId: actor.companyId, customerId: row.customerId, contractId: null, measurementId: null, invoiceNumber: row.number, accrualDate }, lines, base, actor.userId);
    await tx.financial_Retention.updateMany({ where: { financialRecordId: record.id }, data: { fiscalInvoiceId: row.id } });
    await tx.fiscal_InvoiceLink.create({ data: { invoiceId: row.id, amount: base, financialRecordId: record.id } });
    await tx.fiscal_Invoice.update({ where: { id }, data: { receivable: Prisma.JsonNull } });
  }

  // ------------------------------------------------------------------ cancelamento

  async cancel(actor: FiscalActor, id: number, body: Record<string, unknown>) {
    const row = await this.row(actor.companyId, id);
    if (row.status !== 'autorizada') throw new BadRequestException('Só nota autorizada pode ser cancelada');
    const reason = clean(body.reason, 255);
    if (reason.length < 15) throw new BadRequestException('Explique o motivo do cancelamento (pelo menos 15 letras)');
    const reasonCode = ([1, 2, 9].includes(Number(body.reasonCode)) ? Number(body.reasonCode) : 9) as 1 | 2 | 9;
    const records = await this.prisma.financialRecords.findMany({ where: { companyId: actor.companyId, fiscalInvoiceId: id, inactiveAt: null, status: { not: 'cancelled' } }, select: { id: true, status: true, paidAt: true } });
    if (records.some((r) => r.status === 'received' || r.paidAt)) {
      throw new BadRequestException('Esta nota tem conta a receber já recebida. Em vez de cancelar, substitua a nota por uma corrigida.');
    }

    let eventKey: string | null = null;
    let eventInfo: Record<string, unknown> = {};
    if (row.provider === 'sefin') {
      if (!row.accessKey) throw new BadRequestException('A nota não tem chave de acesso');
      const emitter = await this.settings.emitter(actor.companyId);
      const { cert, client } = await this.client(actor.companyId, row.environment);
      const event = buildCancelEvent({ environment: row.environment, authorDocument: emitter.cnpj, accessKey: row.accessKey, reasonCode, reason });
      const signed = signXml(event.xml, 'infPedReg', cert.privateKeyPem, cert.certificatePem);
      let result: SefinResult;
      try {
        result = await client.event(row.accessKey, signed);
      } catch (error) {
        throw new BadRequestException(`${error instanceof Error ? error.message : 'Sem resposta'}. Confira a situação da nota antes de tentar de novo.`);
      }
      // E0840: o cancelamento já tinha sido registrado (reenvio)
      if (!result.ok && !result.errors.some((e) => e.code === 'E0840')) {
        throw new BadRequestException(friendlyMessages(result.errors).map((m) => `${m.code ? `${m.code}: ` : ''}${m.message}`).join(' '));
      }
      if (result.xml) {
        eventKey = `fiscal/${actor.companyId}/nfse-${id}-cancelamento.xml`;
        await this.storage.put(eventKey, Buffer.from(result.xml, 'utf8'), 'application/xml');
        eventInfo = parseEventXml(result.xml);
      }
    }

    const cancelReceivables = body.cancelReceivables !== false;
    await this.prisma.$transaction(async (tx) => {
      await tx.fiscal_Invoice.update({ where: { id }, data: { status: 'cancelada', cancelReason: reason, cancelledAt: new Date(), cancelledByUserId: actor.userId } });
      await tx.fiscal_InvoiceEvent.create({ data: { invoiceId: id, kind: 'cancelada', detail: { motivo: reason, codigo: reasonCode, ...eventInfo } as Prisma.InputJsonValue, xmlKey: eventKey, userId: actor.userId } });
      if (cancelReceivables && records.length) {
        await tx.financialRecords.updateMany({ where: { id: { in: records.map((r) => r.id) } }, data: { status: 'cancelled', inactiveAt: new Date() } });
      }
    });
    return this.get(actor.companyId, id);
  }

  /** Começa a substituição: um rascunho igual à nota, que a pessoa corrige e emite. */
  async startReplacement(actor: FiscalActor, id: number) {
    const row = await this.row(actor.companyId, id);
    if (row.status !== 'autorizada' || row.provider !== 'sefin') throw new BadRequestException('Só nota autorizada emitida pelo sistema pode ser substituída');
    const pending = await this.prisma.fiscal_Invoice.findFirst({ where: { companyId: actor.companyId, replacesId: id, status: { in: ['rascunho', 'rejeitada', 'emitindo'] } } });
    if (pending) return this.get(actor.companyId, pending.id);
    return this.create(actor, { ...this.bodyOf(row), replacesId: id, receivable: undefined });
  }

  // ------------------------------------------------------------------ consulta

  private async row(companyId: number, id: number): Promise<InvoiceRow> {
    const row = await this.prisma.fiscal_Invoice.findFirst({ where: { id, companyId }, include: { links: true, events: { orderBy: { id: 'asc' } } } });
    if (!row) throw new NotFoundException('Nota fiscal não encontrada');
    return row;
  }

  /** Corpo de tela equivalente a uma nota gravada (para revalidar, duplicar ou substituir). */
  bodyOf(row: InvoiceRow | Prisma.Fiscal_InvoiceGetPayload<object>) {
    const service = row.service as unknown as ServiceSnapshot & { extra?: ExtraData };
    const extra = service.extra ?? {};
    const taker = row.taker as unknown as TakerSnapshot;
    return {
      takerKind: row.takerKind, customerId: row.customerId, traineeId: row.traineeId,
      taker: { document: taker.document, name: taker.name, municipalRegistration: taker.municipalRegistration, email: taker.email, phone: taker.phone, address: taker.address ?? null },
      serviceCodeId: row.serviceCodeId, nationalCode: service.nationalCode, nbsCode: service.nbsCode, issTaxation: service.issTaxation,
      description: row.description, placeOfService: row.placeOfService, competence: row.competence.toISOString().slice(0, 10),
      grossValue: Number(row.grossValue), discountValue: Number(row.discountValue), issRate: row.issRate === null ? null : Number(row.issRate), issWithheld: row.issWithheld,
      retentions: extra.retentions ?? {}, reference: extra.reference ?? null, order: extra.order ?? null, notes: extra.notes ?? '',
      receivable: row.receivable ? { create: true, ...(row.receivable as object) } : undefined,
    } as Record<string, unknown>;
  }

  private out(row: InvoiceRow | (Prisma.Fiscal_InvoiceGetPayload<object> & { links?: unknown[]; events?: unknown[] })) {
    const service = row.service as unknown as ServiceSnapshot & { extra?: ExtraData };
    const { extra, ...serviceOut } = service;
    return {
      id: row.id,
      status: row.status,
      statusLabel: STATUS_LABEL[row.status],
      provider: row.provider,
      environment: row.environment,
      takerKind: row.takerKind,
      customerId: row.customerId,
      traineeId: row.traineeId,
      taker: row.taker as unknown as TakerSnapshot,
      service: serviceOut,
      serviceCodeId: row.serviceCodeId,
      description: row.description,
      placeOfService: row.placeOfService,
      competence: row.competence.toISOString().slice(0, 10),
      grossValue: Number(row.grossValue),
      discountValue: Number(row.discountValue),
      issRate: row.issRate === null ? null : Number(row.issRate),
      issValue: Number(row.issValue),
      issWithheld: row.issWithheld,
      federalRetentions: row.federalRetentions as Record<FederalTax, number> | null,
      retentions: extra?.retentions ?? {},
      reference: extra?.reference ?? null,
      order: extra?.order ?? null,
      notes: extra?.notes ?? null,
      netValue: Number(row.netValue),
      dpsSeries: row.dpsSeries,
      dpsNumber: row.dpsNumber,
      dpsId: row.dpsId,
      accessKey: row.accessKey,
      number: row.number,
      issuedAt: iso(row.issuedAt),
      sentAt: iso(row.sentAt),
      hasXml: !!row.xmlKey,
      externalUrl: row.externalUrl,
      messages: (row.messages as Array<{ code: string; message: string }> | null) ?? [],
      receivable: row.receivable,
      replacesId: row.replacesId,
      replacedById: row.replacedById,
      cancelReason: row.cancelReason,
      cancelledAt: iso(row.cancelledAt),
      emailSentAt: iso(row.emailSentAt),
      emailSentTo: row.emailSentTo,
      createdAt: iso(row.createdAt),
      links: row.links,
      events: row.events,
    };
  }

  async get(companyId: number, id: number) {
    const row = await this.row(companyId, id);
    const records = await this.prisma.financialRecords.findMany({
      where: { companyId, fiscalInvoiceId: id },
      select: { id: true, description: true, value: true, netValue: true, status: true, dueDate: true, paidAt: true, inactiveAt: true },
      orderBy: { id: 'asc' },
    });
    return { ...this.out(row), receivables: records.map((r) => ({ ...r, value: Number(r.value ?? 0), netValue: r.netValue === null ? null : Number(r.netValue) })) };
  }

  async list(companyId: number, query: Record<string, unknown>) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const where: Prisma.Fiscal_InvoiceWhereInput = { companyId };
    const statuses = String(query.status ?? '').split(',').filter((s) => STATUS_LABEL[s]);
    if (statuses.length) where.status = { in: statuses as Prisma.EnumFiscalInvoiceStatusFilter['in'] };
    if (query.environment === 'producao' || query.environment === 'restrita') where.environment = query.environment;
    if (query.customerId) where.customerId = Number(query.customerId);
    const from = dateOnly(query.from);
    const to = dateOnly(query.to);
    if (from || to) where.competence = { ...(from ? { gte: new Date(`${from}T00:00:00Z`) } : {}), ...(to ? { lte: new Date(`${to}T00:00:00Z`) } : {}) };
    const q = clean(query.q);
    if (q) {
      const doc = digits(q);
      where.OR = [
        { description: { contains: q, mode: 'insensitive' } },
        { number: { contains: q } },
        { taker: { path: ['name'], string_contains: q } },
        ...(doc.length >= 4 ? [{ taker: { path: ['document'], string_contains: doc } }, { accessKey: { contains: doc } }] : []),
      ];
    }
    const [rows, total, sums, counts] = await Promise.all([
      this.prisma.fiscal_Invoice.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.prisma.fiscal_Invoice.count({ where }),
      this.prisma.fiscal_Invoice.aggregate({ where: { ...where, status: 'autorizada' }, _sum: { grossValue: true, issValue: true, netValue: true }, _count: true }),
      this.prisma.fiscal_Invoice.groupBy({ by: ['status'], where: { ...where, status: undefined }, _count: true }),
    ]);
    return {
      data: rows.map((r) => this.out(r)),
      total,
      page,
      limit,
      summary: {
        authorized: sums._count,
        gross: Number(sums._sum.grossValue ?? 0),
        iss: Number(sums._sum.issValue ?? 0),
        net: Number(sums._sum.netValue ?? 0),
        retained: round2(Number(sums._sum.grossValue ?? 0) - Number(sums._sum.netValue ?? 0)),
        byStatus: Object.fromEntries(counts.map((c) => [c.status, c._count])),
      },
    };
  }

  // ------------------------------------------------------------------ arquivos e e-mail

  async xml(companyId: number, id: number): Promise<{ body: Buffer; fileName: string }> {
    const row = await this.row(companyId, id);
    if (!row.xmlKey) throw new NotFoundException('Esta nota não tem XML (rascunho ou emitida fora do sistema)');
    return { body: await this.storage.get(row.xmlKey), fileName: `NFS-e ${row.number ?? row.id}.xml` };
  }

  async pdf(companyId: number, id: number): Promise<{ body: Buffer; fileName: string }> {
    const row = await this.row(companyId, id);
    const [emitter, settings] = await Promise.all([this.settings.emitter(companyId), this.settings.settingsRow(companyId)]);
    const fed = (row.federalRetentions as Record<FederalTax, number> | null) ?? { inss: 0, ir: 0, csll: 0, pis: 0, cofins: 0 };
    const taker = row.taker as unknown as TakerSnapshot;
    const service = row.service as unknown as ServiceSnapshot & { extra?: ExtraData };
    const body = await renderDanfse({
      environment: row.environment,
      status: row.status,
      accessKey: row.accessKey,
      number: row.number,
      dpsSeries: row.dpsSeries,
      dpsNumber: row.dpsNumber,
      issuedAt: row.issuedAt,
      competence: row.competence,
      emitter: { name: emitter.name, cnpj: emitter.cnpj, municipalRegistration: settings.municipalRegistration, address: emitter.address, cityName: emitter.cityName, uf: emitter.uf, email: emitter.email, phone: emitter.phone },
      taker: { document: taker.document, name: taker.name, municipalRegistration: taker.municipalRegistration, email: taker.email, phone: taker.phone, address: taker.address ? { ...taker.address, ibge: taker.address.ibge ?? undefined } : null },
      service: { nationalCode: service.nationalCode, nationalLabel: service.nationalLabel, municipalCode: service.municipalCode, nbsCode: service.nbsCode },
      description: row.description,
      placeOfService: row.placeOfService,
      values: {
        gross: Number(row.grossValue), discount: Number(row.discountValue), base: round2(Number(row.grossValue) - Number(row.discountValue)),
        issRate: row.issRate === null ? null : Number(row.issRate), issValue: Number(row.issValue), issWithheld: row.issWithheld,
        federal: { inss: Number(fed.inss ?? 0), ir: Number(fed.ir ?? 0), csll: Number(fed.csll ?? 0), pis: Number(fed.pis ?? 0), cofins: Number(fed.cofins ?? 0) },
        net: Number(row.netValue),
      },
      notes: service.extra?.notes ?? null,
    });
    return { body, fileName: `NFS-e ${row.number ?? `rascunho ${row.id}`}.pdf` };
  }

  /** Envia o PDF e o XML ao contato fiscal do tomador (ou ao e-mail informado). */
  async send(actor: FiscalActor, id: number, body: Record<string, unknown>) {
    const row = await this.row(actor.companyId, id);
    if (row.status !== 'autorizada') throw new BadRequestException('Só nota autorizada pode ser enviada');
    const taker = row.taker as unknown as TakerSnapshot;
    const to = String(body.to ?? taker.email ?? '').split(/[;,\s]+/).map((s) => s.trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
    if (!to.length) throw new BadRequestException('O tomador não tem e-mail. Informe para quem enviar.');
    if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) throw new BadRequestException('O envio de e-mail não está configurado no servidor. Baixe o PDF e envie por outro canal.');
    const emitter = await this.settings.emitter(actor.companyId);
    const pdf = await this.pdf(actor.companyId, id);
    const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [{ filename: pdf.fileName, content: pdf.body, contentType: 'application/pdf' }];
    if (row.xmlKey) attachments.push({ filename: `NFS-e ${row.number ?? row.id}.xml`, content: await this.storage.get(row.xmlKey), contentType: 'application/xml' });
    this.email.initialize({
      host: process.env.EMAIL_HOST, port: parseInt(process.env.EMAIL_PORT || '587', 10), secure: process.env.EMAIL_SECURE === 'true',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }, from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    });
    const subject = `Nota fiscal de serviço nº ${row.number ?? ''} — ${emitter.name}`;
    const html = `<p>Olá,</p><p>Segue a nota fiscal de serviço <b>nº ${row.number ?? ''}</b> emitida por <b>${emitter.name}</b>, no valor de <b>${brl(Number(row.grossValue))}</b>${Number(row.netValue) !== Number(row.grossValue) ? ` (líquido a pagar ${brl(Number(row.netValue))})` : ''}.</p>${row.accessKey ? `<p>Chave de acesso: ${row.accessKey}</p>` : ''}<p>O PDF e o XML estão anexos.</p>`;
    try {
      await this.email.sendEmail({ to, subject, html, attachments });
    } catch {
      throw new BadRequestException('Não foi possível enviar o e-mail agora. Baixe o PDF e envie por outro canal.');
    }
    await this.prisma.$transaction([
      this.prisma.fiscal_Invoice.update({ where: { id }, data: { emailSentAt: new Date(), emailSentTo: to.join(', ').slice(0, 500) } }),
      this.prisma.fiscal_InvoiceEvent.create({ data: { invoiceId: id, kind: 'email', detail: { para: to }, userId: actor.userId } }),
    ]);
    return this.get(actor.companyId, id);
  }
}
