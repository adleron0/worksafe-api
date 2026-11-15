import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Hr_DocumentType, Hr_EmployeeDocument, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { recordFlowEvent } from 'src/common/flow/flow';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  DEFAULT_DOCUMENT_TYPES, DOCUMENT_FOLDERS, DOCUMENT_STATUS_LABEL, DocumentStatus, FolderStatus, documentStatus, requiredFor, suggestedExpiry, worstStatus,
} from './document.rules';
import { PrivateStorageService } from './private-storage.service';

/**
 * Documentos do funcionário: arquivos em pastas, com vencimento quando faz
 * sentido (ASO, NRs, treinamentos).
 *
 * O arquivo fica no armazenamento privado e só sai pela API, com a permissão
 * conferida e o download registrado. "Vencido", "a vencer" e "faltando" não são
 * gravados: saem da data de validade e dos tipos obrigatórios a cada leitura.
 */
type Body = Record<string, any>;
export interface DocumentActor { userId: number; companyId: number }
export interface UploadedDocument { buffer: Buffer; originalname: string; mimetype: string; size: number }
export const DOCUMENTS_VIEW_PERMISSION = 'view_documentos_funcionarios';
export const DOCUMENTS_WRITE_PERMISSION = 'update_documentos_funcionarios';
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/;

const clean = (value: unknown, max = 255) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const blank = (value: unknown) => value === undefined || value === null || value === '';
const truthy = (value: unknown) => value === true || value === 'true' || value === 1 || value === '1';
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
/** Hoje no horário de Brasília (UTC−3). */
const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
function dateOf(value: unknown, label: string): string {
  const raw = /^(\d{4}-\d{2}-\d{2})(T.*)?$/.exec(String(value ?? '').trim())?.[1] ?? '';
  if (!raw || Number.isNaN(asDate(raw).getTime()) || iso(asDate(raw)) !== raw) throw new BadRequestException(`${label}: informe uma data válida`);
  return raw;
}
const FOLDER_IDS = DOCUMENT_FOLDERS.map((folder) => folder.id);
const FOLDER_NAME = new Map(DOCUMENT_FOLDERS.map((folder) => [folder.id, folder.name]));

type DocumentWithType = Hr_EmployeeDocument & { type: Hr_DocumentType };
/** Quem conta para vencimentos e obrigatórios: cadastro ativo e sem desligamento até hoje. */
const WORKING = (day: string): Prisma.Hr_EmployeeWhereInput => ({ inactiveAt: null, OR: [{ terminationDate: null }, { terminationDate: { gt: asDate(day) } }] });

@Injectable()
export class EmployeeDocumentService {
  constructor(private readonly prisma: PrismaService, private readonly storage: PrivateStorageService) {}

  // ------------------------------------------------------------------ tipos de documento

  /** A empresa começa com a lista padrão (ASO, NRs, ficha de registro...) na primeira vez que abre os documentos. */
  private async ensureDefaults(companyId: number): Promise<void> {
    if (await this.prisma.hr_DocumentType.count({ where: { companyId } })) return;
    await this.prisma.hr_DocumentType.createMany({
      data: DEFAULT_DOCUMENT_TYPES.map((type) => ({
        companyId, name: type.name, folder: type.folder, expires: !!type.expires, validityMonths: type.validityMonths ?? null, required: !!type.required, inIntegration: !!type.inIntegration,
      })),
      skipDuplicates: true,
    });
  }

  private presentType(type: Hr_DocumentType) {
    return {
      id: type.id, name: type.name, folder: type.folder, folderName: FOLDER_NAME.get(type.folder) ?? type.folder, expires: type.expires, validityMonths: type.validityMonths,
      warnDays: type.warnDays, required: type.required, requiredProfessionalIds: (Array.isArray(type.requiredProfessionalIds) ? type.requiredProfessionalIds : []) as number[],
      inIntegration: type.inIntegration, inactive: !!type.inactiveAt,
    };
  }

  async types(actor: DocumentActor, query: Record<string, string> = {}) {
    await this.ensureDefaults(actor.companyId);
    const [rows, professionals] = await Promise.all([
      this.prisma.hr_DocumentType.findMany({ where: { companyId: actor.companyId, ...(query.inactive === 'true' ? {} : { inactiveAt: null }) }, orderBy: [{ name: 'asc' }] }),
      this.prisma.commercial_Professional.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ]);
    const order = (folder: string) => { const index = FOLDER_IDS.indexOf(folder); return index < 0 ? 99 : index; };
    return { folders: DOCUMENT_FOLDERS, professionals, rows: rows.sort((a, b) => order(a.folder) - order(b.folder) || a.name.localeCompare(b.name, 'pt-BR')).map((type) => this.presentType(type)) };
  }

  private async typeData(companyId: number, body: Body, current: Hr_DocumentType | null): Promise<Prisma.Hr_DocumentTypeUncheckedUpdateInput> {
    const data: Prisma.Hr_DocumentTypeUncheckedUpdateInput = {};
    if ('name' in body || !current) {
      const name = clean(body.name, 120);
      if (name.length < 2) throw new BadRequestException('Informe o nome do tipo de documento');
      const taken = await this.prisma.hr_DocumentType.findFirst({ where: { companyId, name: { equals: name, mode: 'insensitive' }, ...(current ? { id: { not: current.id } } : {}) }, select: { id: true } });
      if (taken) throw new ConflictException('Já existe um tipo de documento com este nome');
      data.name = name;
    }
    if ('folder' in body || !current) {
      const folder = blank(body.folder) ? 'outros' : String(body.folder);
      if (!FOLDER_IDS.includes(folder)) throw new BadRequestException('Pasta inválida');
      data.folder = folder;
    }
    if ('expires' in body) data.expires = truthy(body.expires);
    const expires = 'expires' in body ? truthy(body.expires) : current?.expires ?? false;
    if ('validityMonths' in body || 'expires' in body) {
      const months = blank(body.validityMonths) ? null : Number(body.validityMonths);
      if (months !== null && (!Number.isInteger(months) || months < 1 || months > 240)) throw new BadRequestException('Validade: informe de 1 a 240 meses');
      data.validityMonths = expires ? ('validityMonths' in body ? months : current?.validityMonths ?? null) : null;
    }
    if ('warnDays' in body) {
      const days = blank(body.warnDays) ? 30 : Number(body.warnDays);
      if (!Number.isInteger(days) || days < 0 || days > 365) throw new BadRequestException('Aviso: informe de 0 a 365 dias');
      data.warnDays = days;
    }
    if ('required' in body) data.required = truthy(body.required);
    if ('inIntegration' in body) data.inIntegration = truthy(body.inIntegration);
    if ('requiredProfessionalIds' in body) {
      const ids = Array.isArray(body.requiredProfessionalIds) ? [...new Set(body.requiredProfessionalIds.map(Number).filter((id: number) => Number.isInteger(id) && id > 0))] as number[] : [];
      if (ids.length && (await this.prisma.commercial_Professional.count({ where: { id: { in: ids }, companyId } })) !== ids.length) throw new BadRequestException('Função não encontrada no cadastro de profissionais');
      data.requiredProfessionalIds = ids;
    }
    return data;
  }

  async createType(actor: DocumentActor, body: Body) {
    await this.ensureDefaults(actor.companyId);
    const data = await this.typeData(actor.companyId, body, null);
    const created = await this.prisma.hr_DocumentType.create({ data: { ...(data as Prisma.Hr_DocumentTypeUncheckedCreateInput), companyId: actor.companyId } });
    return this.presentType(created);
  }

  private async typeById(companyId: number, id: number) {
    const type = await this.prisma.hr_DocumentType.findFirst({ where: { id, companyId } });
    if (!type) throw new NotFoundException('Tipo de documento não encontrado');
    return type;
  }

  async updateType(actor: DocumentActor, id: number, body: Body) {
    const type = await this.typeById(actor.companyId, id);
    return this.presentType(await this.prisma.hr_DocumentType.update({ where: { id }, data: await this.typeData(actor.companyId, body, type) }));
  }

  /** Tipo inativo não aceita envio novo; os documentos que já existem continuam na pasta. */
  async setTypeActive(actor: DocumentActor, id: number, active: boolean) {
    await this.typeById(actor.companyId, id);
    return this.presentType(await this.prisma.hr_DocumentType.update({ where: { id }, data: { inactiveAt: active ? null : new Date() } }));
  }

  // ------------------------------------------------------------------ pastas do funcionário

  private async employeeOf(companyId: number, employeeId: number) {
    const employee = await this.prisma.hr_Employee.findFirst({ where: { id: employeeId, companyId }, select: { id: true, name: true, companyId: true, terminationDate: true, inactiveAt: true, roles: { select: { professionalId: true } } } });
    if (!employee) throw new NotFoundException('Funcionário não encontrado');
    return employee;
  }

  private presentDocument(document: DocumentWithType, day: string, userName: Map<number, string>) {
    const status: DocumentStatus = document.type.expires || document.expiryDate ? documentStatus(iso(document.expiryDate), document.type.warnDays, day) : 'sem_validade';
    return {
      id: document.id, typeId: document.typeId, typeName: document.type.name, folder: document.type.folder, issueDate: iso(document.issueDate), expiryDate: iso(document.expiryDate),
      status, statusLabel: DOCUMENT_STATUS_LABEL[status], fileName: document.fileName, mimeType: document.mimeType, size: document.size, notes: document.notes,
      uploadedBy: document.uploadedByUserId ? userName.get(document.uploadedByUserId) ?? null : null, createdAt: document.createdAt, replacedAt: document.replacedAt,
    };
  }

  /** As pastas de um funcionário: o documento vigente de cada tipo, as versões anteriores e os obrigatórios que faltam. */
  async ofEmployee(actor: DocumentActor, employeeId: number) {
    await this.ensureDefaults(actor.companyId);
    const employee = await this.employeeOf(actor.companyId, employeeId);
    const [documents, types] = await Promise.all([
      this.prisma.hr_EmployeeDocument.findMany({ where: { employeeId, inactiveAt: null }, include: { type: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      this.prisma.hr_DocumentType.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' } }),
    ]);
    const userIds = [...new Set(documents.map((document) => document.uploadedByUserId).filter((id): id is number => !!id))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const userName = new Map(users.map((user) => [user.id, user.name]));
    const day = today();
    const working = !employee.inactiveAt && (!employee.terminationDate || iso(employee.terminationDate)! > day);
    const roleIds = employee.roles.map((role) => role.professionalId);
    const current = documents.filter((document) => !document.replacedAt);
    const have = new Set(current.map((document) => document.typeId));
    const folders = DOCUMENT_FOLDERS.map((folder) => {
      const rows = current.filter((document) => document.type.folder === folder.id).map((document) => ({
        ...this.presentDocument(document, day, userName),
        versions: documents.filter((old) => old.replacedAt && old.typeId === document.typeId).map((old) => this.presentDocument(old, day, userName)),
      })).sort((a, b) => a.typeName.localeCompare(b.typeName, 'pt-BR'));
      // quem já saiu da empresa não tem pendência de documento
      const missing = working ? types.filter((type) => type.folder === folder.id && !have.has(type.id) && requiredFor(type, roleIds)).map((type) => ({ typeId: type.id, typeName: type.name })) : [];
      const status = worstStatus([...rows.map((row) => row.status as FolderStatus), ...missing.map(() => 'faltando' as FolderStatus)]);
      return { id: folder.id, name: folder.name, count: rows.length, status, statusLabel: DOCUMENT_STATUS_LABEL[status], documents: rows, missing };
    });
    const status = worstStatus(folders.map((folder) => folder.status));
    return { employee: { id: employee.id, name: employee.name }, status, statusLabel: DOCUMENT_STATUS_LABEL[status], folders, types: types.map((type) => this.presentType(type)) };
  }

  /** O sinal de documentos de cada funcionário, para a lista: o pior entre vencido, faltando, a vencer e em dia. */
  async signals(companyId: number, employeeIds: number[]): Promise<Map<number, FolderStatus>> {
    const out = new Map<number, FolderStatus>();
    if (!employeeIds.length) return out;
    const day = today();
    const [documents, types, employees] = await Promise.all([
      this.prisma.hr_EmployeeDocument.findMany({ where: { employeeId: { in: employeeIds }, inactiveAt: null, replacedAt: null }, include: { type: true } }),
      this.prisma.hr_DocumentType.findMany({ where: { companyId, inactiveAt: null, required: true } }),
      this.prisma.hr_Employee.findMany({ where: { id: { in: employeeIds }, companyId, ...WORKING(day) }, select: { id: true, roles: { select: { professionalId: true } } } }),
    ]);
    const byEmployee = new Map<number, FolderStatus[]>();
    const have = new Map<number, Set<number>>();
    for (const document of documents) {
      const status: FolderStatus = document.type.expires || document.expiryDate ? documentStatus(iso(document.expiryDate), document.type.warnDays, day) : 'sem_validade';
      byEmployee.set(document.employeeId, [...(byEmployee.get(document.employeeId) ?? []), status]);
      have.set(document.employeeId, (have.get(document.employeeId) ?? new Set()).add(document.typeId));
    }
    for (const employee of employees) {
      const roleIds = employee.roles.map((role) => role.professionalId);
      if (types.some((type) => !have.get(employee.id)?.has(type.id) && requiredFor(type, roleIds))) byEmployee.set(employee.id, [...(byEmployee.get(employee.id) ?? []), 'faltando']);
    }
    for (const id of employeeIds) out.set(id, worstStatus(byEmployee.get(id) ?? []));
    return out;
  }

  // ------------------------------------------------------------------ envio, correção e retirada

  private datesOf(type: Hr_DocumentType, body: Body, current?: Hr_EmployeeDocument) {
    const issue = 'issueDate' in body ? (blank(body.issueDate) ? null : dateOf(body.issueDate, 'Emissão')) : iso(current?.issueDate) ?? null;
    if (issue && issue > today()) throw new BadRequestException('A emissão não pode ser no futuro');
    let expiry = 'expiryDate' in body ? (blank(body.expiryDate) ? null : dateOf(body.expiryDate, 'Vencimento')) : iso(current?.expiryDate) ?? null;
    // sem vencimento informado, vale a validade do tipo contada da emissão
    if (!expiry && !current && type.expires && issue && type.validityMonths) expiry = suggestedExpiry(issue, type.validityMonths);
    if (type.expires && !expiry) throw new BadRequestException(`${type.name} tem validade: informe o vencimento`);
    if (issue && expiry && expiry < issue) throw new BadRequestException('O vencimento não pode ser antes da emissão');
    return { issueDate: issue ? asDate(issue) : null, expiryDate: expiry ? asDate(expiry) : null };
  }

  /** Envia um documento. Se já havia um vigente do mesmo tipo, ele vira versão anterior. */
  async upload(actor: DocumentActor, employeeId: number, file: UploadedDocument | undefined, body: Body) {
    const employee = await this.employeeOf(actor.companyId, employeeId);
    if (!file?.buffer?.length) throw new BadRequestException('Envie o arquivo do documento');
    if (!ALLOWED_MIME.test(file.mimetype)) throw new BadRequestException('O documento deve ser PDF ou imagem (JPG, PNG, WEBP, HEIC)');
    if (file.size > DOCUMENT_MAX_BYTES) throw new BadRequestException('O arquivo passa de 10 MB');
    const type = await this.prisma.hr_DocumentType.findFirst({ where: { id: Number(body.typeId), companyId: actor.companyId, inactiveAt: null } });
    if (!type) throw new BadRequestException('Escolha o tipo do documento');
    const dates = this.datesOf(type, body);
    const extension = (file.originalname.match(/\.[a-zA-Z0-9]{1,5}$/)?.[0] ?? '').toLowerCase();
    // a chave não leva nome nem CPF: só ids e um identificador aleatório
    const fileKey = `hr/${employee.companyId}/${employee.id}/${randomUUID()}${extension}`;
    await this.storage.put(fileKey, file.buffer, file.mimetype);
    await this.prisma.$transaction(async (tx) => {
      await tx.hr_EmployeeDocument.updateMany({ where: { employeeId, typeId: type.id, inactiveAt: null, replacedAt: null }, data: { replacedAt: new Date() } });
      await tx.hr_EmployeeDocument.create({ data: {
        companyId: employee.companyId, employeeId, typeId: type.id, ...dates, fileKey, fileName: clean(file.originalname, 200) || 'documento', mimeType: file.mimetype, size: file.size,
        notes: clean(body.notes, 500) || null, uploadedByUserId: actor.userId || null,
      } });
    });
    return this.ofEmployee(actor, employeeId);
  }

  private async byId(companyId: number, id: number): Promise<DocumentWithType> {
    const document = await this.prisma.hr_EmployeeDocument.findFirst({ where: { id, companyId, inactiveAt: null }, include: { type: true } });
    if (!document) throw new NotFoundException('Documento não encontrado');
    return document;
  }

  /** Corrige as datas ou a observação de um documento (o arquivo só muda enviando outro). */
  async update(actor: DocumentActor, id: number, body: Body) {
    const document = await this.byId(actor.companyId, id);
    const dates = this.datesOf(document.type, body, document);
    await this.prisma.hr_EmployeeDocument.update({ where: { id }, data: { ...dates, ...('notes' in body ? { notes: clean(body.notes, 500) || null } : {}) } });
    return this.ofEmployee(actor, document.employeeId);
  }

  /** Tira um documento enviado por engano. Se era o vigente, a versão anterior volta a valer. O arquivo não é apagado do armazenamento. */
  async remove(actor: DocumentActor, id: number) {
    const document = await this.byId(actor.companyId, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.hr_EmployeeDocument.update({ where: { id }, data: { inactiveAt: new Date() } });
      if (document.replacedAt) return;
      const previous = await tx.hr_EmployeeDocument.findFirst({ where: { employeeId: document.employeeId, typeId: document.typeId, inactiveAt: null, replacedAt: { not: null } }, orderBy: [{ replacedAt: 'desc' }, { id: 'desc' }] });
      if (previous) await tx.hr_EmployeeDocument.update({ where: { id: previous.id }, data: { replacedAt: null } });
      await recordFlowEvent(tx, 'hr_document', { companyId: document.companyId, entityId: id, type: 'retirado', userId: actor.userId });
    });
    return this.ofEmployee(actor, document.employeeId);
  }

  /** O arquivo, para ver ou baixar. Cada acesso fica registrado (quem e quando). */
  async file(actor: DocumentActor, id: number) {
    const document = await this.byId(actor.companyId, id);
    const body = await this.storage.get(document.fileKey);
    await recordFlowEvent(this.prisma, 'hr_document', { companyId: document.companyId, entityId: id, type: 'download', userId: actor.userId });
    return { body, fileName: document.fileName, mimeType: document.mimeType };
  }

  // ------------------------------------------------------------------ vencimentos

  /** Tudo o que pede ação, de quem está na empresa: vencidos, a vencer e obrigatórios que faltam. */
  private async pending(companyId: number) {
    const day = today();
    const [documents, types, employees] = await Promise.all([
      this.prisma.hr_EmployeeDocument.findMany({
        where: { companyId, inactiveAt: null, replacedAt: null, expiryDate: { not: null }, employee: WORKING(day) },
        include: { type: true, employee: { select: { id: true, name: true } } }, orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }], take: 5000,
      }),
      this.prisma.hr_DocumentType.findMany({ where: { companyId, inactiveAt: null, required: true } }),
      this.prisma.hr_Employee.findMany({ where: { companyId, ...WORKING(day) }, select: { id: true, name: true, roles: { select: { professionalId: true } }, documents: { where: { inactiveAt: null, replacedAt: null }, select: { typeId: true } } }, orderBy: { name: 'asc' }, take: 5000 }),
    ]);
    const rows: Array<{ key: string; documentId: number | null; employee: { id: number; name: string }; typeId: number; typeName: string; status: FolderStatus; statusLabel: string; expiryDate: string | null; days: number | null }> = [];
    for (const document of documents) {
      const expiry = iso(document.expiryDate)!;
      const status = documentStatus(expiry, document.type.warnDays, day);
      if (status === 'em_dia') continue;
      rows.push({ key: `d${document.id}`, documentId: document.id, employee: document.employee, typeId: document.typeId, typeName: document.type.name, status, statusLabel: DOCUMENT_STATUS_LABEL[status], expiryDate: expiry, days: Math.round((asDate(expiry).getTime() - asDate(day).getTime()) / 86400000) });
    }
    for (const employee of employees) {
      const have = new Set(employee.documents.map((document) => document.typeId));
      const roleIds = employee.roles.map((role) => role.professionalId);
      for (const type of types) if (!have.has(type.id) && requiredFor(type, roleIds)) {
        rows.push({ key: `m${employee.id}-${type.id}`, documentId: null, employee: { id: employee.id, name: employee.name }, typeId: type.id, typeName: type.name, status: 'faltando', statusLabel: DOCUMENT_STATUS_LABEL.faltando, expiryDate: null, days: null });
      }
    }
    return { day, rows };
  }

  async expiring(actor: DocumentActor, query: Record<string, string>) {
    await this.ensureDefaults(actor.companyId);
    const { day, rows } = await this.pending(actor.companyId);
    const summary = { vencido: 0, a_vencer: 0, faltando: 0 };
    for (const row of rows) summary[row.status as keyof typeof summary] += 1;
    const term = clean(query.search, 80).toLowerCase();
    const typeId = Number(query.typeId) > 0 ? Number(query.typeId) : null;
    const filtered = rows.filter((row) => (!query.status || row.status === query.status) && (!typeId || row.typeId === typeId) && (!term || row.employee.name.toLowerCase().includes(term)));
    const types = await this.prisma.hr_DocumentType.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
    return { today: day, summary, total: filtered.length, rows: filtered.slice(0, 500), types };
  }

  /** Os blocos de documentos da "Minha esteira". */
  async pipelineBlocks(companyId: number) {
    if (!(await this.prisma.hr_DocumentType.count({ where: { companyId } }))) return [];
    const { rows } = await this.pending(companyId);
    const br = (value: string | null) => (value ? value.split('-').reverse().join('/') : '');
    const block = (key: string, status: FolderStatus, title: string, hint: string) => {
      const list = rows.filter((row) => row.status === status);
      return {
        key, area: 'RH', title, hint, count: list.length, total: null, link: '/rh/vencimentos',
        items: list.slice(0, 5).map((row) => ({
          id: row.documentId ?? row.employee.id, title: row.employee.name, value: null, late: status === 'vencido', link: `/rh/funcionarios/${row.employee.id}`,
          subtitle: status === 'faltando' ? `${row.typeName} · não enviado` : `${row.typeName} · ${status === 'vencido' ? 'venceu em' : 'vence em'} ${br(row.expiryDate)}`,
        })),
      };
    };
    return [
      block('docs_vencidos', 'vencido', 'Documentos vencidos', 'Documentos de funcionários com a validade passada'),
      block('docs_vencer', 'a_vencer', 'Documentos a vencer', 'Vencem dentro do prazo de aviso de cada tipo'),
      block('docs_faltando', 'faltando', 'Documentos obrigatórios faltando', 'Obrigatórios que ainda não foram enviados'),
    ];
  }
}
