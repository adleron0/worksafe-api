import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { buildXlsx } from 'src/common/xlsx';
import { buildZip, ZipEntry, zipSafeName } from 'src/common/zip';
import { PrivateStorageService } from 'src/common/storage/private-storage.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { clean, digits, round2, todayBr } from './fiscal.utils';
import { FiscalInvoiceService } from './invoice.service';
import { parseReceivedXml } from './nfse-xml';
import { AdnClient, SefinTransportError } from './sefin.client';
import { FiscalActor, FiscalSettingsService } from './settings.service';

const STATUS = ['nova', 'lancada', 'ignorada', 'cancelada'];
const dateOnly = (value: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '').slice(0, 10)) ? String(value).slice(0, 10) : null);
const noonUtc = (date: string) => new Date(`${date}T15:00:00.000Z`);

/**
 * Notas recebidas: as NFS-e que fornecedores emitiram contra a empresa, baixadas
 * da distribuição do ambiente nacional por NSU. Cada uma vira uma sugestão de
 * conta a pagar (fornecedor pelo CNPJ, valor líquido, vencimento a escolher).
 * Também monta o pacote mensal do contador (XML/PDF emitidas e recebidas +
 * planilha resumo).
 */
@Injectable()
export class FiscalReceivedService {
  private readonly logger = new Logger(FiscalReceivedService.name);
  private syncing = new Set<number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: FiscalSettingsService,
    private readonly invoices: FiscalInvoiceService,
    private readonly storage: PrivateStorageService,
  ) {}

  /** Lê a distribuição a partir do último NSU até não haver mais nada (no máximo 20 lotes por vez). */
  async sync(companyId: number) {
    if (this.syncing.has(companyId)) throw new ConflictException('Já estou buscando as notas recebidas: aguarde um pouco');
    this.syncing.add(companyId);
    try {
      const row = await this.settings.settingsRow(companyId);
      const emitter = await this.settings.emitter(companyId);
      const cert = await this.settings.certificate(companyId);
      const client = new AdnClient(row.environment, cert);
      let nsu = row.receivedLastNsu;
      let created = 0;
      let seen = 0;
      for (let round = 0; round < 20; round++) {
        const { docs, done, errors } = await client.fromNsu(nsu);
        if (errors.length) throw new BadRequestException(errors.map((e) => `${e.code}: ${e.description}`).join(' '));
        for (const doc of docs) {
          seen++;
          nsu = Math.max(nsu, doc.nsu);
          if (!/NFSE/i.test(doc.type) || !doc.xml) continue;
          const parsed = parseReceivedXml(doc.xml);
          // só o que a empresa TOMOU; as notas que ela mesma emitiu já estão na área fiscal
          if (!parsed.accessKey || digits(parsed.takerDocument) !== emitter.cnpj || digits(parsed.issuerDocument) === emitter.cnpj) continue;
          const exists = await this.prisma.fiscal_ReceivedInvoice.findUnique({ where: { companyId_accessKey: { companyId, accessKey: parsed.accessKey } } });
          if (exists) continue;
          const key = `fiscal/${companyId}/recebidas/${parsed.accessKey}.xml`;
          await this.storage.put(key, Buffer.from(doc.xml, 'utf8'), 'application/xml');
          const supplier = parsed.issuerDocument ? await this.prisma.financial_Supplier.findFirst({ where: { companyId, document: digits(parsed.issuerDocument) }, select: { id: true } }) : null;
          await this.prisma.fiscal_ReceivedInvoice.create({
            data: {
              companyId, nsu: doc.nsu, accessKey: parsed.accessKey, number: parsed.number ?? null,
              issuedAt: parsed.processedAt ? new Date(parsed.processedAt) : null,
              competence: parsed.competence ? new Date(`${parsed.competence}T00:00:00Z`) : null,
              issuerDocument: digits(parsed.issuerDocument).slice(0, 14), issuerName: clean(parsed.issuerName, 300) || 'Fornecedor',
              description: parsed.description ?? null, grossValue: parsed.gross, netValue: parsed.net || parsed.gross,
              issWithheld: parsed.issWithheld, issValue: parsed.issValue, retentions: parsed.retentions as unknown as Prisma.InputJsonValue,
              supplierId: supplier?.id ?? null, xmlKey: key,
            },
          });
          created++;
        }
        if (done) break;
      }
      await this.prisma.fiscal_Settings.update({ where: { companyId }, data: { receivedLastNsu: nsu, receivedSyncedAt: new Date() } });
      return { created, seen, lastNsu: nsu };
    } catch (error) {
      if (error instanceof SefinTransportError) throw new BadRequestException(error.message);
      throw error;
    } finally {
      this.syncing.delete(companyId);
    }
  }

  /** De tempos em tempos, para quem tem certificado: notas recebidas chegam sozinhas. */
  @Cron('0 20 */6 * * *')
  async scheduled() {
    if (process.env.FISCAL_AUTO_EMIT_DISABLED === 'true') return;
    const rows = await this.prisma.fiscal_Settings.findMany({ where: { certificateEncrypted: { not: null } }, select: { companyId: true } });
    for (const row of rows) await this.sync(row.companyId).catch((error) => this.logger.warn(`Notas recebidas (empresa ${row.companyId}): ${error instanceof Error ? error.message : error}`));
  }

  async list(companyId: number, query: Record<string, unknown>) {
    const where: Prisma.Fiscal_ReceivedInvoiceWhereInput = { companyId };
    if (STATUS.includes(String(query.status))) where.status = String(query.status);
    const q = clean(query.q);
    if (q) where.OR = [{ issuerName: { contains: q, mode: 'insensitive' } }, { number: { contains: q } }, { issuerDocument: { contains: digits(q) || q } }];
    const [rows, counts, settings] = await Promise.all([
      this.prisma.fiscal_ReceivedInvoice.findMany({ where, orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }], take: 200 }),
      this.prisma.fiscal_ReceivedInvoice.groupBy({ by: ['status'], where: { companyId }, _count: true }),
      this.settings.settingsRow(companyId),
    ]);
    return {
      data: rows.map((r) => ({ ...r, grossValue: Number(r.grossValue), netValue: Number(r.netValue), issValue: Number(r.issValue) })),
      byStatus: Object.fromEntries(counts.map((c) => [c.status, c._count])),
      syncedAt: settings.receivedSyncedAt,
    };
  }

  private async row(companyId: number, id: number) {
    const row = await this.prisma.fiscal_ReceivedInvoice.findFirst({ where: { id, companyId } });
    if (!row) throw new NotFoundException('Nota recebida não encontrada');
    return row;
  }

  async xml(companyId: number, id: number) {
    const row = await this.row(companyId, id);
    if (!row.xmlKey) throw new NotFoundException('XML não guardado');
    return { body: await this.storage.get(row.xmlKey), fileName: `NFS-e ${row.number ?? row.id} ${row.issuerName}.xml` };
  }

  /**
   * Lança a nota recebida como conta a pagar: fornecedor (o cadastrado ou um
   * novo pelo CNPJ da nota), valor líquido (o que a empresa paga ao fornecedor
   * depois das retenções), vencimento escolhido e o número da nota.
   */
  async createPayable(actor: FiscalActor, id: number, body: Record<string, unknown>) {
    const row = await this.row(actor.companyId, id);
    if (row.status === 'lancada') throw new ConflictException('Esta nota já virou conta a pagar');
    const dueDate = dateOnly(body.dueDate);
    if (!dueDate) throw new BadRequestException('Informe o vencimento');
    const value = body.value !== undefined && body.value !== null && body.value !== '' ? round2(Number(body.value)) : Number(row.netValue);
    if (!(value > 0)) throw new BadRequestException('Valor inválido');
    const payable = await this.prisma.$transaction(async (tx) => {
      let supplierId = Number(body.supplierId) || row.supplierId;
      if (!supplierId) {
        const found = await tx.financial_Supplier.findFirst({ where: { companyId: actor.companyId, document: row.issuerDocument }, select: { id: true } });
        supplierId = found?.id ?? (await tx.financial_Supplier.create({ data: { companyId: actor.companyId, name: row.issuerName.slice(0, 160), document: row.issuerDocument } })).id;
      }
      const competence = (row.competence ?? row.issuedAt ?? new Date()).toISOString().slice(0, 7);
      const created = await tx.financial_Payable.create({
        data: {
          companyId: actor.companyId, supplierId, value, dueDate: noonUtc(dueDate), accrualDate: competence, status: 'aberta', origin: 'nfse',
          description: clean(body.description, 255) || `NFS-e ${row.number ?? ''} · ${row.issuerName}`.slice(0, 255),
          documentNumber: row.number, paymentMethod: body.paymentMethod ? String(body.paymentMethod) : null,
          chartAccountId: Number(body.chartAccountId) || null, costCenterId: Number(body.costCenterId) || null,
          observations: Number(row.grossValue) !== value ? `Nota de ${Number(row.grossValue).toFixed(2).replace('.', ',')}; retenções descontadas: recolher na guia.` : null,
          createdByUserId: actor.userId,
        },
      });
      await tx.fiscal_ReceivedInvoice.update({ where: { id }, data: { status: 'lancada', payableId: created.id, supplierId, handledByUserId: actor.userId, handledAt: new Date() } });
      return created;
    });
    return { ok: true, payableId: payable.id };
  }

  async setStatus(actor: FiscalActor, id: number, status: 'ignorada' | 'nova') {
    const row = await this.row(actor.companyId, id);
    if (row.status === 'lancada') throw new ConflictException('Esta nota já virou conta a pagar');
    await this.prisma.fiscal_ReceivedInvoice.update({ where: { id }, data: { status, handledByUserId: actor.userId, handledAt: new Date() } });
    return { ok: true };
  }

  // ------------------------------------------------------------------ pacote do contador

  /** ZIP do mês: XML e PDF das notas emitidas, XML das recebidas e a planilha resumo. */
  async accountantPackage(companyId: number, month: unknown) {
    const m = String(month ?? '').slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new BadRequestException('Informe o mês (AAAA-MM)');
    const [y, mm] = m.split('-').map(Number);
    const from = new Date(Date.UTC(y, mm - 1, 1));
    const to = new Date(Date.UTC(y, mm, 1));
    const issued = await this.prisma.fiscal_Invoice.findMany({
      where: { companyId, environment: 'producao', status: { in: ['autorizada', 'cancelada', 'substituida'] }, competence: { gte: from, lt: to } },
      orderBy: [{ number: 'asc' }, { id: 'asc' }],
    });
    const received = await this.prisma.fiscal_ReceivedInvoice.findMany({
      where: { companyId, status: { not: 'cancelada' }, OR: [{ competence: { gte: from, lt: to } }, { competence: null, issuedAt: { gte: from, lt: to } }] },
      orderBy: [{ issuedAt: 'asc' }],
    });
    const entries: ZipEntry[] = [];
    for (const inv of issued) {
      const base = zipSafeName(`NFS-e ${inv.number ?? inv.id}`);
      if (inv.xmlKey) entries.push({ name: `emitidas/${base}.xml`, data: await this.storage.get(inv.xmlKey) });
      const pdf = await this.invoices.pdf(companyId, inv.id).catch(() => null);
      if (pdf) entries.push({ name: `emitidas/${base}.pdf`, data: pdf.body });
    }
    for (const rec of received) {
      if (rec.xmlKey) entries.push({ name: `recebidas/${zipSafeName(`${rec.issuerName} NFS-e ${rec.number ?? rec.id}`)}.xml`, data: await this.storage.get(rec.xmlKey) });
    }
    const fed = (json: unknown) => (json ?? {}) as Record<string, number>;
    const sheet = buildXlsx([
      {
        name: 'Emitidas',
        columns: [{ header: 'Número' }, { header: 'Situação' }, { header: 'Emissão' }, { header: 'Competência' }, { header: 'Tomador' }, { header: 'CPF/CNPJ' }, { header: 'Valor' }, { header: 'ISS' }, { header: 'ISS retido' }, { header: 'INSS' }, { header: 'IR' }, { header: 'CSLL' }, { header: 'PIS' }, { header: 'COFINS' }, { header: 'Líquido' }, { header: 'Chave' }],
        rows: issued.map((inv) => {
          const t = inv.taker as { name?: string; document?: string };
          const f = fed(inv.federalRetentions);
          return [inv.number, inv.status, { date: inv.issuedAt }, { date: inv.competence }, t.name, t.document, { money: Number(inv.grossValue) }, { money: Number(inv.issValue) }, inv.issWithheld ? 'sim' : 'não',
            { money: f.inss ?? 0 }, { money: f.ir ?? 0 }, { money: f.csll ?? 0 }, { money: f.pis ?? 0 }, { money: f.cofins ?? 0 }, { money: Number(inv.netValue) }, inv.accessKey];
        }),
      },
      {
        name: 'Recebidas',
        columns: [{ header: 'Número' }, { header: 'Emissão' }, { header: 'Competência' }, { header: 'Fornecedor' }, { header: 'CNPJ' }, { header: 'Valor' }, { header: 'ISS retido' }, { header: 'INSS' }, { header: 'IR' }, { header: 'CSLL' }, { header: 'PIS' }, { header: 'COFINS' }, { header: 'Líquido' }, { header: 'Situação' }, { header: 'Chave' }],
        rows: received.map((r) => {
          const f = fed(r.retentions);
          return [r.number, { date: r.issuedAt }, { date: r.competence }, r.issuerName, r.issuerDocument, { money: Number(r.grossValue) }, r.issWithheld ? 'sim' : 'não',
            { money: f.inss ?? 0 }, { money: f.ir ?? 0 }, { money: f.csll ?? 0 }, { money: f.pis ?? 0 }, { money: f.cofins ?? 0 }, { money: Number(r.netValue) }, r.status, r.accessKey];
        }),
      },
    ]);
    entries.push({ name: `resumo-${m}.xlsx`, data: sheet });
    return { body: buildZip(entries), fileName: `notas-fiscais-${m}.zip`, counts: { issued: issued.length, received: received.length, generatedAt: todayBr() } };
  }
}
