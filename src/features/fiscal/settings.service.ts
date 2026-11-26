import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CertificateError, decryptCertificate, encryptCertificate, loadCertificate, LoadedCertificate } from './certificate';
import { NBS } from './data/nbs';
import { CORRELACAO_IBSCBS, IND_OP } from './data/ibscbs';
import { SERVICOS_NACIONAIS } from './data/servicos-nacionais';
import { clean, digits, ibgeOf, normalizeName, toNumber } from './fiscal.utils';
import { SefinClient, SefinTransportError } from './sefin.client';

export interface FiscalActor { userId: number; companyId: number }

const SETTINGS_FIELDS = ['environment', 'municipalRegistration', 'simplesNacional', 'simplesRegime', 'specialRegime', 'simplesTotalRate', 'pisCofinsCst', 'dpsSeries', 'nextDpsNumber', 'nextDpsNumberTest', 'autoSendEmail', 'autoEmitTraining', 'ibsCbsEnabled', 'rentalNfseFrom', 'defaultNotes'] as const;
const CST_VALUES = new Set(['00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '49', '50', '51', '52', '53', '54', '55', '56', '60', '61', '62', '63', '64', '65', '66', '67', '70', '71', '72', '73', '74', '75', '98', '99']);

/** Empresa emissora como a nota precisa dela. */
export interface Emitter {
  companyId: number;
  cnpj: string;
  name: string;
  ibge: string | null;
  cityName: string | null;
  uf: string | null;
  address: string;
  email: string | null;
  phone: string | null;
  logoUrl: string | null;
}

/**
 * Configuração fiscal da empresa: dados de emissão, certificado A1, série da
 * DPS e o catálogo de serviços fiscais. O certificado nunca sai da API: a tela
 * recebe só titular, CNPJ e validade.
 */
@Injectable()
export class FiscalSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async settingsRow(companyId: number) {
    const found = await this.prisma.fiscal_Settings.findUnique({ where: { companyId } });
    if (found) return found;
    return this.prisma.fiscal_Settings.upsert({ where: { companyId }, create: { companyId }, update: {} });
  }

  async emitter(companyId: number): Promise<Emitter> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, include: { city: true, state: true } });
    if (!company) throw new NotFoundException('Empresa não encontrada');
    const uf = company.state?.uf ?? null;
    return {
      companyId,
      cnpj: digits(company.cnpj),
      name: company.corporate_name || company.comercial_name,
      ibge: company.city ? ibgeOf(company.city.name, uf) : null,
      cityName: company.city?.name ?? null,
      uf,
      address: [company.address, company.addressNumber, company.addressComplement, company.neighborhood].filter(Boolean).join(', '),
      email: company.financial_email || company.representative_email || null,
      phone: company.financial_contact || company.representative_contact || null,
      logoUrl: company.logoUrl,
    };
  }

  /** O que a tela de configuração mostra, com a lista do que falta para emitir. */
  async get(companyId: number) {
    const [row, emitter, services] = await Promise.all([
      this.settingsRow(companyId),
      this.emitter(companyId),
      this.prisma.fiscal_ServiceCode.count({ where: { companyId, inactiveAt: null } }),
    ]);
    const { certificateEncrypted, ...rest } = row;
    const pending: string[] = [];
    if (!process.env.FISCAL_SECRET) pending.push('O servidor ainda não tem a chave FISCAL_SECRET (sem ela o certificado não pode ser guardado).');
    if (!emitter.ibge) pending.push('Cadastre a cidade da empresa (Configurações da empresa): o código IBGE sai dela.');
    if (!certificateEncrypted) pending.push('Envie o certificado digital A1 (.pfx) da empresa.');
    if (row.certificateValidTo && row.certificateValidTo.getTime() < Date.now()) pending.push('O certificado digital venceu. Envie o novo.');
    if (row.certificateDocument && row.certificateDocument.slice(0, 8) !== emitter.cnpj.slice(0, 8)) pending.push('O certificado é de outro CNPJ. Envie o certificado da empresa.');
    if (row.simplesNacional === 3 && (row.simplesTotalRate === null || Number(row.simplesTotalRate) <= 0)) pending.push('Informe o % aproximado dos tributos no Simples (vai na nota).');
    if (!services) pending.push('Cadastre pelo menos um serviço fiscal (código de tributação nacional).');
    if (row.ibsCbsEnabled) {
      const missing = await this.prisma.fiscal_ServiceCode.count({ where: { companyId, inactiveAt: null, OR: [{ ibsCbsIndOp: null }, { ibsCbsClassTrib: null }] } });
      if (missing) pending.push(`IBS/CBS ligado: ${missing} serviço(s) fiscal(is) sem indicador da operação ou cClassTrib.`);
    }
    const daysLeft = row.certificateValidTo ? Math.floor((row.certificateValidTo.getTime() - Date.now()) / 86400000) : null;
    return {
      ...rest,
      simplesTotalRate: row.simplesTotalRate === null ? null : Number(row.simplesTotalRate),
      hasCertificate: !!certificateEncrypted,
      certificateDaysLeft: daysLeft,
      emitter,
      serviceCodes: services,
      ready: pending.length === 0,
      pending,
    };
  }

  async update(actor: FiscalActor, body: Record<string, unknown>) {
    const current = await this.settingsRow(actor.companyId);
    const data: Prisma.Fiscal_SettingsUpdateInput = { updatedByUserId: actor.userId };
    for (const field of SETTINGS_FIELDS) {
      if (!(field in body)) continue;
      const value = body[field];
      switch (field) {
        case 'environment':
          if (value !== 'restrita' && value !== 'producao') throw new BadRequestException('Ambiente inválido');
          data.environment = value;
          break;
        case 'municipalRegistration':
          data.municipalRegistration = clean(value, 15) || null;
          break;
        case 'simplesNacional': {
          const n = Number(value);
          if (![1, 2, 3].includes(n)) throw new BadRequestException('Situação no Simples inválida');
          data.simplesNacional = n;
          break;
        }
        case 'simplesRegime': {
          const n = value === null || value === '' ? null : Number(value);
          if (n !== null && ![1, 2, 3].includes(n)) throw new BadRequestException('Regime de apuração do Simples inválido');
          data.simplesRegime = n;
          break;
        }
        case 'specialRegime': {
          const n = Number(value);
          if (![0, 1, 2, 3, 4, 5, 6, 9].includes(n)) throw new BadRequestException('Regime especial inválido');
          data.specialRegime = n;
          break;
        }
        case 'simplesTotalRate': {
          const n = value === null || value === '' ? null : toNumber(value);
          if (n !== null && (n < 0 || n > 100)) throw new BadRequestException('O % aproximado dos tributos vai de 0 a 100');
          data.simplesTotalRate = n;
          break;
        }
        case 'pisCofinsCst': {
          const cst = digits(value).padStart(2, '0');
          if (!CST_VALUES.has(cst)) throw new BadRequestException('CST do PIS/COFINS inválido');
          data.pisCofinsCst = cst;
          break;
        }
        case 'dpsSeries': {
          const n = Number(digits(value));
          if (!n || n < 1 || n > 49999) throw new BadRequestException('A série da DPS de sistema próprio vai de 1 a 49999');
          data.dpsSeries = String(n);
          break;
        }
        case 'nextDpsNumber':
        case 'nextDpsNumberTest': {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1) throw new BadRequestException('O próximo número da DPS precisa ser inteiro e maior que zero');
          const used = await this.prisma.fiscal_Invoice.aggregate({
            where: { companyId: actor.companyId, environment: field === 'nextDpsNumber' ? 'producao' : 'restrita', dpsSeries: String(body.dpsSeries ?? current.dpsSeries) },
            _max: { dpsNumber: true },
          });
          if (used._max.dpsNumber && n <= used._max.dpsNumber) throw new BadRequestException(`O número ${used._max.dpsNumber} já foi usado nesta série: o próximo precisa ser maior.`);
          data[field] = n;
          break;
        }
        case 'autoSendEmail':
          data.autoSendEmail = !!value;
          break;
        case 'ibsCbsEnabled':
          data.ibsCbsEnabled = !!value;
          break;
        case 'rentalNfseFrom': {
          const text = String(value ?? '').slice(0, 10);
          if (value && !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new BadRequestException('Data da NFS-e de locação inválida');
          data.rentalNfseFrom = value ? new Date(`${text}T00:00:00.000Z`) : null;
          break;
        }
        case 'autoEmitTraining':
          data.autoEmitTraining = !!value;
          // só os pagamentos de agora em diante: ligar não emite o que já estava pago
          if (value && !current.autoEmitTraining) data.autoEmitTrainingSince = new Date();
          if (!value) data.autoEmitTrainingSince = null;
          break;
        case 'defaultNotes':
          data.defaultNotes = clean(value) ? String(value).slice(0, 4000) : null;
          break;
      }
    }
    await this.prisma.fiscal_Settings.update({ where: { companyId: actor.companyId }, data });
    return this.get(actor.companyId);
  }

  // ------------------------------------------------------------------ certificado

  async saveCertificate(actor: FiscalActor, file: Buffer | undefined, password: unknown) {
    if (!file?.length) throw new BadRequestException('Envie o arquivo do certificado (.pfx ou .p12)');
    if (file.length > 50_000) throw new BadRequestException('Arquivo grande demais para um certificado A1');
    let cert: LoadedCertificate;
    try {
      cert = loadCertificate(file, String(password ?? ''));
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Certificado inválido');
    }
    if (cert.validTo.getTime() < Date.now()) throw new BadRequestException(`Este certificado venceu em ${cert.validTo.toLocaleDateString('pt-BR')}.`);
    const emitter = await this.emitter(actor.companyId);
    if (cert.document && cert.document.length === 14 && cert.document.slice(0, 8) !== emitter.cnpj.slice(0, 8)) {
      throw new BadRequestException(`O certificado é do CNPJ ${cert.document}, mas a empresa é ${emitter.cnpj}.`);
    }
    let encrypted: string;
    try {
      encrypted = encryptCertificate(file, String(password ?? ''));
    } catch (error) {
      throw new BadRequestException(error instanceof CertificateError ? error.message : 'Não foi possível guardar o certificado');
    }
    await this.settingsRow(actor.companyId);
    await this.prisma.fiscal_Settings.update({
      where: { companyId: actor.companyId },
      data: {
        certificateEncrypted: encrypted,
        certificateSubject: cert.subject.slice(0, 255),
        certificateDocument: cert.document,
        certificateValidFrom: cert.validFrom,
        certificateValidTo: cert.validTo,
        certificateUpdatedAt: new Date(),
        updatedByUserId: actor.userId,
      },
    });
    return this.get(actor.companyId);
  }

  async removeCertificate(actor: FiscalActor) {
    await this.settingsRow(actor.companyId);
    await this.prisma.fiscal_Settings.update({
      where: { companyId: actor.companyId },
      data: { certificateEncrypted: null, certificateSubject: null, certificateDocument: null, certificateValidFrom: null, certificateValidTo: null, certificateUpdatedAt: new Date(), updatedByUserId: actor.userId },
    });
    return this.get(actor.companyId);
  }

  /** Certificado aberto, pronto para assinar e conectar. */
  async certificate(companyId: number): Promise<LoadedCertificate> {
    const row = await this.settingsRow(companyId);
    if (!row.certificateEncrypted) throw new BadRequestException('Envie o certificado digital A1 da empresa em Financeiro → Fiscal.');
    try {
      const { pfx, password } = decryptCertificate(row.certificateEncrypted);
      const cert = loadCertificate(pfx, password);
      if (cert.validTo.getTime() < Date.now()) throw new BadRequestException('O certificado digital venceu. Envie o novo em Financeiro → Fiscal.');
      return cert;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(error instanceof Error ? error.message : 'Não foi possível abrir o certificado');
    }
  }

  /** Testa a conexão com o ambiente nacional usando o certificado (consulta de uma DPS que não existe). */
  async testConnection(companyId: number) {
    const [row, emitter] = await Promise.all([this.settingsRow(companyId), this.emitter(companyId)]);
    const cert = await this.certificate(companyId);
    const client = new SefinClient(row.environment, cert, 20_000);
    const probe = `DPS${(emitter.ibge ?? '0000000').padStart(7, '0')}2${emitter.cnpj.padStart(14, '0')}${'49999'}${'9'.repeat(15)}`;
    try {
      const exists = await client.dpsExists(probe);
      return { ok: true, environment: row.environment, message: `Conexão com o ambiente nacional (${row.environment === 'producao' ? 'produção' : 'produção restrita'}) funcionando.`, exists };
    } catch (error) {
      const message = error instanceof SefinTransportError ? error.message : error instanceof Error ? error.message : 'Falha na conexão';
      return { ok: false, environment: row.environment, message: /403/.test(message) ? 'O ambiente nacional recusou o certificado.' : message };
    }
  }

  // ------------------------------------------------------------------ serviços fiscais

  async listServiceCodes(companyId: number, includeInactive = false) {
    const rows = await this.prisma.fiscal_ServiceCode.findMany({
      where: { companyId, ...(includeInactive ? {} : { inactiveAt: null }) },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    return rows.map((r) => this.serviceCodeOut(r));
  }

  serviceCodeOut(r: Prisma.Fiscal_ServiceCodeGetPayload<object>) {
    const nat = SERVICOS_NACIONAIS.find((s) => s[0] === r.nationalCode);
    const nbs = r.nbsCode ? NBS.find((n) => n[0] === r.nbsCode) : null;
    const indOp = r.ibsCbsIndOp ? IND_OP.find((i) => i[0] === r.ibsCbsIndOp) : null;
    return {
      ...r, issRate: r.issRate === null ? null : Number(r.issRate), nationalLabel: nat ? `${nat[1]} — ${nat[2]}` : null, nbsLabel: nbs?.[1] ?? null,
      ibsCbsIndOpLabel: indOp?.[1] ?? null, ibsCbsSuggestion: ibsCbsSuggestionOf(r.nationalCode),
    };
  }

  private serviceCodeData(body: Record<string, unknown>, partial: boolean): Prisma.Fiscal_ServiceCodeUncheckedUpdateInput {
    const data: Prisma.Fiscal_ServiceCodeUncheckedUpdateInput = {};
    if (!partial || 'name' in body) {
      const name = clean(body.name, 120);
      if (!name) throw new BadRequestException('Dê um nome ao serviço fiscal');
      data.name = name;
    }
    if (!partial || 'nationalCode' in body) {
      const code = digits(body.nationalCode).padStart(6, '0');
      if (!SERVICOS_NACIONAIS.some((s) => s[0] === code)) throw new BadRequestException('Código de tributação nacional não encontrado na lista oficial');
      data.nationalCode = code;
    }
    if ('municipalCode' in body) data.municipalCode = clean(body.municipalCode, 20) || null;
    if ('nbsCode' in body) {
      const nbs = digits(body.nbsCode);
      if (nbs && !NBS.some((n) => n[0] === nbs)) throw new BadRequestException('Código NBS não encontrado na tabela oficial');
      data.nbsCode = nbs || null;
    }
    if ('issRate' in body) {
      const rate = body.issRate === null || body.issRate === '' ? null : toNumber(body.issRate);
      if (rate !== null && (rate < 0 || rate > 5)) throw new BadRequestException('A alíquota do ISS vai de 0 a 5%');
      data.issRate = rate;
    }
    if ('issTaxation' in body) {
      const n = Number(body.issTaxation);
      if (![1, 2, 3, 4].includes(n)) throw new BadRequestException('Tributação do ISS inválida');
      data.issTaxation = n;
    }
    if (!partial || 'description' in body) {
      const description = String(body.description ?? '').trim();
      if (!description) throw new BadRequestException('Escreva a descrição padrão do serviço');
      data.description = description.slice(0, 2000);
    }
    if ('isDefault' in body) data.isDefault = !!body.isDefault;
    if ('ibsCbsIndOp' in body) {
      const code = digits(body.ibsCbsIndOp);
      if (code && !IND_OP.some((i) => i[0] === code)) throw new BadRequestException('Indicador da operação não encontrado no Anexo C');
      data.ibsCbsIndOp = code || null;
    }
    if ('ibsCbsClassTrib' in body) {
      const code = digits(body.ibsCbsClassTrib);
      if (code && code.length !== 6) throw new BadRequestException('O cClassTrib tem 6 dígitos (os 3 primeiros são o CST)');
      data.ibsCbsClassTrib = code || null;
    }
    return data;
  }

  async createServiceCode(actor: FiscalActor, body: Record<string, unknown>) {
    const data = this.serviceCodeData(body, false) as Prisma.Fiscal_ServiceCodeUncheckedCreateInput;
    const created = await this.prisma.$transaction(async (tx) => {
      if (data.isDefault) await tx.fiscal_ServiceCode.updateMany({ where: { companyId: actor.companyId }, data: { isDefault: false } });
      return tx.fiscal_ServiceCode.create({ data: { ...data, companyId: actor.companyId } });
    });
    return this.serviceCodeOut(created);
  }

  async updateServiceCode(actor: FiscalActor, id: number, body: Record<string, unknown>) {
    const found = await this.prisma.fiscal_ServiceCode.findFirst({ where: { id, companyId: actor.companyId } });
    if (!found) throw new NotFoundException('Serviço fiscal não encontrado');
    const data = this.serviceCodeData(body, true);
    if ('active' in body) data.inactiveAt = body.active ? null : new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      if (data.isDefault) await tx.fiscal_ServiceCode.updateMany({ where: { companyId: actor.companyId, id: { not: id } }, data: { isDefault: false } });
      return tx.fiscal_ServiceCode.update({ where: { id }, data });
    });
    return this.serviceCodeOut(updated);
  }

  // ------------------------------------------------------------------ tabelas oficiais

  searchNationalCodes(q: unknown) {
    const term = normalizeName(q);
    const code = digits(q);
    // "0802", "08.02" ou "802" acham o 080201; texto busca na descrição
    const byCode = (s: (typeof SERVICOS_NACIONAIS)[number]) => s[0].startsWith(code) || s[0].startsWith(`0${code}`) || digits(s[1]).startsWith(code);
    const textOnly = term.replace(/[\d\s]+/g, '');
    return SERVICOS_NACIONAIS.filter((s) => (!term && !code) || (code && byCode(s)) || (textOnly && normalizeName(`${s[1]} ${s[2]}`).includes(term)))
      .slice(0, 40)
      .map(([codigo, item, descricao]) => ({ code: codigo, item, description: descricao }));
  }

  listIndOp() {
    return IND_OP.map(([code, description, place]) => ({ code, description, place }));
  }

  searchNbs(q: unknown) {
    const term = normalizeName(q);
    const code = digits(q);
    return NBS.filter((n) => (!term && !code) || (code && n[0].startsWith(code)) || (term && normalizeName(n[1]).includes(term)))
      .slice(0, 40)
      .map(([codigo, descricao]) => ({ code: codigo, description: descricao }));
  }
}

/**
 * Sugestão de indicador da operação e cClassTrib pelo item da lista de serviços
 * (Anexo VIII, ainda "trabalho inicial": o contador confirma). Locação de bens
 * móveis (99.04) não está no anexo: vai o indicador geral com aviso.
 */
export function ibsCbsSuggestionOf(nationalCode: string): { indOp: string; classTrib: string; name: string; note?: string } | null {
  const item = `${nationalCode.slice(0, 2)}.${nationalCode.slice(2, 4)}`;
  if (item === '99.04') return { indOp: '100301', classTrib: '000001', name: 'Situações tributadas integralmente pelo IBS e CBS.', note: 'Locação de bens móveis ainda não está na tabela de correlação: confirme com o contador.' };
  const found = CORRELACAO_IBSCBS[item];
  return found ? { indOp: found[0], classTrib: found[1], name: found[2] } : null;
}
