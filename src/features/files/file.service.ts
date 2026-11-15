import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { File_DocumentType, File_Folder, File_Item, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { DOCUMENT_STATUS_LABEL, DocumentStatus, FolderStatus, documentStatus, suggestedExpiry, worstStatus } from 'src/common/documents/expiry';
import { recordFlowEvent } from 'src/common/flow/flow';
import { PrivateStorageService } from 'src/common/storage/private-storage.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { DEFAULT_FILE_TYPES, DEFAULT_FOLDERS, FILE_MAX_BYTES, TRASH_DAYS, cleanName, downloadName, extensionOf, fold, opensInline, uploadedName } from './file.rules';

/**
 * Arquivos da empresa: pastas livres em árvore e os arquivos dentro delas.
 *
 * O arquivo fica no armazenamento privado e só sai pela API, com a permissão
 * conferida e o acesso registrado. Cada pasta pode ser aberta a todos que usam
 * o módulo ou restrita a alguns perfis; as de dentro seguem a de cima. Apagar
 * manda para a lixeira; depois de 30 dias a linha e o arquivo somem de verdade.
 *
 * Qualquer arquivo pode ter vencimento, direto ou sugerido pelo tipo de
 * documento. "Vencido", "a vencer" e "faltando" não são gravados: saem da data
 * de validade e dos tipos obrigatórios a cada leitura. Substituir um arquivo
 * guarda o anterior como versão.
 */
type Body = Record<string, any>;
export interface FileActor { userId: number; companyId: number; canWrite: boolean; canManage: boolean }
export interface UploadedFile { buffer: Buffer; originalname: string; mimetype: string; size: number }
export const FILES_VIEW_PERMISSION = 'view_arquivos';
export const FILES_WRITE_PERMISSION = 'update_arquivos';
export const FILES_MANAGE_PERMISSION = 'manage_arquivos';
const FILE_ENTITY = 'company_file';
const FOLDER_ENTITY = 'company_folder';
const LIST_LIMIT = 2000;
const SEARCH_LIMIT = 200;
const DEFAULT_WARN_DAYS = 30;

const truthy = (value: unknown) => value === true || value === 'true' || value === 1 || value === '1';
const blank = (value: unknown) => value === undefined || value === null || value === '';
const idsOf = (value: unknown): number[] => (Array.isArray(value) ? [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))] : []);
const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);
const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
/** Hoje no horário de Brasília (UTC−3). */
const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
function dateOf(value: unknown, label: string): string {
  const raw = /^(\d{4}-\d{2}-\d{2})(T.*)?$/.exec(String(value ?? '').trim())?.[1] ?? '';
  if (!raw || Number.isNaN(asDate(raw).getTime()) || iso(asDate(raw)) !== raw) throw new BadRequestException(`${label}: informe uma data válida`);
  return raw;
}

type FileRow = File_Item & { type: File_DocumentType | null };
const WITH_TYPE = { type: true } as const;
/** Só a versão vigente de cada arquivo conta nas listas. */
const CURRENT = { trashedAt: null, replacedAt: null } as const;
const warnOf = (file: { warnDays: number | null; type: { warnDays: number } | null }) => file.warnDays ?? file.type?.warnDays ?? DEFAULT_WARN_DAYS;
const statusOf = (file: { expiryDate: Date | null; warnDays: number | null; type: { warnDays: number } | null }, day: string): DocumentStatus => documentStatus(iso(file.expiryDate), warnOf(file), day);

/** A árvore de pastas da empresa, com o que a pessoa pode ver. */
interface Tree {
  all: Map<number, File_Folder>;
  /** A pasta e as de cima, da raiz até ela. */
  chain(id: number): File_Folder[];
  /** O perfil da pessoa entra na pasta e em todas as de cima. */
  allowed(id: number): boolean;
  /** Nem a pasta nem as de cima estão na lixeira. */
  live(id: number): boolean;
  children(parentId: number | null): File_Folder[];
  /** A pasta e todas as de dentro (em qualquer situação). */
  descendants(id: number): number[];
}
export interface PendingRow {
  key: string; fileId: number | null; folderId: number | null; name: string; where: string; typeId: number | null; typeName: string | null;
  status: FolderStatus; statusLabel: string; expiryDate: string | null; days: number | null;
}

@Injectable()
export class CompanyFileService {
  /** A limpeza da lixeira roda no máximo uma vez por dia por empresa, quando alguém abre o módulo. */
  private readonly purgedOn = new Map<number, string>();

  constructor(private readonly prisma: PrismaService, private readonly storage: PrivateStorageService) {}

  // ------------------------------------------------------------------ árvore e acesso

  private async tree(actor: FileActor): Promise<Tree> {
    const [rows, user] = await Promise.all([
      this.prisma.file_Folder.findMany({ where: { companyId: actor.companyId }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
      actor.canManage ? null : this.prisma.user.findFirst({ where: { id: actor.userId, companyId: actor.companyId }, select: { profileId: true } }),
    ]);
    const profileId = user?.profileId ?? 0;
    const all = new Map(rows.map((row) => [row.id, row]));
    const byParent = new Map<number | null, File_Folder[]>();
    for (const row of rows) byParent.set(row.parentId, [...(byParent.get(row.parentId) ?? []), row]);
    const chain = (id: number) => {
      const out: File_Folder[] = [];
      for (let at = all.get(id), guard = 0; at && guard < 100; at = at.parentId ? all.get(at.parentId) : undefined, guard++) out.unshift(at);
      return out;
    };
    const enters = (folder: File_Folder) => !folder.restricted || actor.canManage || idsOf(folder.profileIds).includes(profileId);
    const descendants = (id: number) => {
      const out = [id];
      for (let i = 0; i < out.length; i++) for (const child of byParent.get(out[i]) ?? []) out.push(child.id);
      return out;
    };
    return {
      all, chain, descendants,
      allowed: (id) => { const path = chain(id); return path.length > 0 && path.every(enters); },
      live: (id) => { const path = chain(id); return path.length > 0 && path.every((folder) => !folder.trashedAt); },
      children: (parentId) => byParent.get(parentId) ?? [],
    };
  }

  /** A pasta, se existe, não está na lixeira e a pessoa pode entrar nela. Sem acesso responde como se não existisse. */
  private folderOf(tree: Tree, id: number): File_Folder {
    const folder = tree.all.get(id);
    if (!folder || !tree.live(id) || !tree.allowed(id)) throw new NotFoundException('Pasta não encontrada');
    return folder;
  }

  /** O arquivo vigente (ou, com `version`, também uma versão anterior), numa pasta que a pessoa vê. */
  private async fileOf(actor: FileActor, tree: Tree, id: number, options: { trashed?: boolean; version?: boolean } = {}): Promise<FileRow> {
    const trashed = !!options.trashed;
    const file = await this.prisma.file_Item.findFirst({ where: { id, companyId: actor.companyId }, include: WITH_TYPE });
    if (!file || !tree.allowed(file.folderId) || !!file.trashedAt !== trashed || (!trashed && !tree.live(file.folderId)) || (!!file.replacedAt && !options.version)) throw new NotFoundException('Arquivo não encontrado');
    return file;
  }

  /** O arquivo e as versões anteriores dele. */
  private groupWhere(file: File_Item): Prisma.File_ItemWhereInput {
    return file.versionGroup ? { companyId: file.companyId, versionGroup: file.versionGroup } : { id: file.id };
  }

  private needWrite(actor: FileActor) { if (!actor.canWrite && !actor.canManage) throw new ForbiddenException('Seu perfil só pode ver os arquivos'); }
  private needManage(actor: FileActor, what: string) { if (!actor.canManage) throw new ForbiddenException(`Só quem administra os arquivos pode ${what}`); }

  /** A empresa começa com as pastas e os tipos de documento sugeridos, uma vez só (mesmo que depois apague todos). */
  private async ensureDefaults(companyId: number): Promise<void> {
    if (!(await this.prisma.file_Folder.count({ where: { companyId } })) && !(await this.prisma.flow_Event.count({ where: { companyId, entity: FOLDER_ENTITY, type: 'pastas_iniciais' } }))) {
      await this.prisma.$transaction(async (tx) => {
        await tx.file_Folder.createMany({ data: DEFAULT_FOLDERS.map((name) => ({ companyId, name })) });
        await recordFlowEvent(tx, FOLDER_ENTITY, { companyId, entityId: 0, type: 'pastas_iniciais' });
      });
    }
    if (!(await this.prisma.file_DocumentType.count({ where: { companyId } }))) {
      await this.prisma.file_DocumentType.createMany({
        data: DEFAULT_FILE_TYPES.map((type) => ({ companyId, name: type.name, expires: !!type.expires, validityMonths: type.validityMonths ?? null })), skipDuplicates: true,
      });
    }
  }

  private async userNames(ids: Array<number | null>): Promise<Map<number, string>> {
    const unique = [...new Set(ids.filter((id): id is number => !!id))];
    const users = unique.length ? await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }) : [];
    return new Map(users.map((user) => [user.id, user.name]));
  }

  private presentFile(file: FileRow, names: Map<number, string>, day = today()) {
    const status = statusOf(file, day);
    return {
      id: file.id, folderId: file.folderId, name: file.name, fileName: file.fileName, mimeType: file.mimeType, size: Number(file.size), notes: file.notes,
      inline: opensInline(file.mimeType), uploadedBy: file.uploadedByUserId ? names.get(file.uploadedByUserId) ?? null : null, createdAt: file.createdAt,
      typeId: file.typeId, typeName: file.type?.name ?? null, issueDate: iso(file.issueDate), expiryDate: iso(file.expiryDate), warnDays: file.warnDays,
      status, statusLabel: DOCUMENT_STATUS_LABEL[status],
    };
  }

  private presentFolder(tree: Tree, folder: File_Folder, counts: Map<number, number>, statuses: Map<number, FolderStatus[]>) {
    const inside = tree.descendants(folder.id).filter((id) => tree.live(id) && tree.allowed(id));
    // a cor da pasta é o pior caso entre os arquivos com validade que a pessoa vê dentro dela
    const status = worstStatus(inside.flatMap((id) => statuses.get(id) ?? []));
    return {
      id: folder.id, parentId: folder.parentId, name: folder.name, restricted: folder.restricted, profileIds: idsOf(folder.profileIds),
      // fechada por ela mesma ou por alguma pasta de cima
      locked: tree.chain(folder.id).some((item) => item.restricted),
      files: inside.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0), folders: inside.length - 1, status, statusLabel: DOCUMENT_STATUS_LABEL[status],
    };
  }

  private async fileCounts(companyId: number): Promise<Map<number, number>> {
    const rows = await this.prisma.file_Item.groupBy({ by: ['folderId'], where: { companyId, ...CURRENT }, _count: { _all: true } });
    return new Map(rows.map((row) => [row.folderId, row._count._all]));
  }

  /** A situação de cada arquivo com validade, por pasta. */
  private async folderStatuses(companyId: number, day: string): Promise<Map<number, FolderStatus[]>> {
    const rows = await this.prisma.file_Item.findMany({ where: { companyId, ...CURRENT, expiryDate: { not: null } }, select: { folderId: true, expiryDate: true, warnDays: true, type: { select: { warnDays: true } } } });
    const out = new Map<number, FolderStatus[]>();
    for (const row of rows) out.set(row.folderId, [...(out.get(row.folderId) ?? []), statusOf(row, day)]);
    return out;
  }

  // ------------------------------------------------------------------ navegar e buscar

  /** O que há numa pasta (ou no primeiro nível, sem `folderId`): o caminho, as pastas de dentro e os arquivos com as versões. */
  async browse(actor: FileActor, folderId: number | null) {
    await this.ensureDefaults(actor.companyId);
    await this.purgeExpired(actor.companyId);
    const tree = await this.tree(actor);
    const folder = folderId ? this.folderOf(tree, folderId) : null;
    const day = today();
    const [counts, statuses, files, types] = await Promise.all([
      this.fileCounts(actor.companyId), this.folderStatuses(actor.companyId, day),
      folder ? this.prisma.file_Item.findMany({ where: { companyId: actor.companyId, folderId: folder.id, ...CURRENT }, include: WITH_TYPE, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: LIST_LIMIT }) : [],
      this.prisma.file_DocumentType.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' } }),
    ]);
    const groups = files.map((file) => file.versionGroup).filter((group): group is string => !!group);
    const old = groups.length ? await this.prisma.file_Item.findMany({ where: { companyId: actor.companyId, versionGroup: { in: groups }, replacedAt: { not: null } }, include: WITH_TYPE, orderBy: [{ replacedAt: 'desc' }, { id: 'desc' }] }) : [];
    const names = await this.userNames([...files, ...old].map((file) => file.uploadedByUserId));
    const folders = tree.children(folder?.id ?? null).filter((child) => !child.trashedAt && tree.allowed(child.id));
    return {
      folder: folder ? this.presentFolder(tree, folder, counts, statuses) : null,
      path: folder ? tree.chain(folder.id).map((item) => ({ id: item.id, name: item.name })) : [],
      folders: folders.map((child) => this.presentFolder(tree, child, counts, statuses)),
      files: files.map((file) => ({
        ...this.presentFile(file, names, day),
        versions: old.filter((version) => version.versionGroup === file.versionGroup).map((version) => ({ ...this.presentFile(version, names, day), replacedAt: version.replacedAt })),
      })),
      types: types.map((type) => this.presentType(type)), maxBytes: FILE_MAX_BYTES, trashDays: TRASH_DAYS,
    };
  }

  /** Todas as pastas que a pessoa vê, com o caminho por extenso: para escolher o destino ao mover. */
  async folders(actor: FileActor) {
    const tree = await this.tree(actor);
    const rows = [...tree.all.values()].filter((folder) => tree.live(folder.id) && tree.allowed(folder.id))
      .map((folder) => ({ id: folder.id, parentId: folder.parentId, name: folder.name, path: tree.chain(folder.id).map((item) => item.name).join(' › ') }));
    return { rows: rows.sort((a, b) => a.path.localeCompare(b.path, 'pt-BR')) };
  }

  /** Busca pelo nome do arquivo, da pasta ou pela observação, sem diferenciar acento nem maiúsculas, só no que a pessoa vê. */
  async search(actor: FileActor, query: Record<string, string>) {
    const term = fold(cleanName(query.q, 80));
    if (term.length < 2) throw new BadRequestException('Digite pelo menos 2 letras para buscar');
    const tree = await this.tree(actor);
    const visible = [...tree.all.values()].filter((folder) => tree.live(folder.id) && tree.allowed(folder.id));
    const pathOf = (id: number) => tree.chain(id).map((item) => ({ id: item.id, name: item.name }));
    const candidates = await this.prisma.file_Item.findMany({
      where: { companyId: actor.companyId, ...CURRENT, folderId: { in: visible.map((folder) => folder.id) } }, include: WITH_TYPE, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 20000,
    });
    const found = candidates.filter((file) => [file.name, file.fileName, file.notes ?? '', file.type?.name ?? ''].some((text) => fold(text).includes(term)));
    const names = await this.userNames(found.slice(0, SEARCH_LIMIT).map((file) => file.uploadedByUserId));
    return {
      folders: visible.filter((folder) => fold(folder.name).includes(term)).slice(0, SEARCH_LIMIT).map((folder) => ({ id: folder.id, name: folder.name, path: pathOf(folder.id) })),
      files: found.slice(0, SEARCH_LIMIT).map((file) => ({ ...this.presentFile(file, names), versions: [], path: pathOf(file.folderId) })),
      total: found.length,
    };
  }

  /** Para quem administra: os perfis que podem ser escolhidos no acesso de uma pasta. */
  async profiles(actor: FileActor) {
    this.needManage(actor, 'definir o acesso das pastas');
    const rows = await this.prisma.profile.findMany({ where: { inactiveAt: null, OR: [{ companyId: actor.companyId }, { companyId: null }] }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
    return { rows };
  }

  // ------------------------------------------------------------------ tipos de documento

  private presentType(type: File_DocumentType) {
    return { id: type.id, name: type.name, expires: type.expires, validityMonths: type.validityMonths, warnDays: type.warnDays, required: type.required, inactive: !!type.inactiveAt };
  }

  async types(actor: FileActor, query: Record<string, string> = {}) {
    await this.ensureDefaults(actor.companyId);
    const rows = await this.prisma.file_DocumentType.findMany({ where: { companyId: actor.companyId, ...(query.inactive === 'true' ? {} : { inactiveAt: null }) } });
    return { rows: rows.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map((type) => this.presentType(type)) };
  }

  private async typeData(companyId: number, body: Body, current: File_DocumentType | null): Promise<Prisma.File_DocumentTypeUncheckedUpdateInput> {
    const data: Prisma.File_DocumentTypeUncheckedUpdateInput = {};
    if ('name' in body || !current) {
      const name = cleanName(body.name, 120);
      if (name.length < 2) throw new BadRequestException('Informe o nome do tipo de documento');
      const taken = await this.prisma.file_DocumentType.findFirst({ where: { companyId, name: { equals: name, mode: 'insensitive' }, ...(current ? { id: { not: current.id } } : {}) }, select: { id: true } });
      if (taken) throw new ConflictException('Já existe um tipo de documento com este nome');
      data.name = name;
    }
    if ('expires' in body) data.expires = truthy(body.expires);
    const expires = 'expires' in body ? truthy(body.expires) : current?.expires ?? false;
    if ('validityMonths' in body || 'expires' in body) {
      const months = blank(body.validityMonths) ? null : Number(body.validityMonths);
      if (months !== null && (!Number.isInteger(months) || months < 1 || months > 240)) throw new BadRequestException('Validade: informe de 1 a 240 meses');
      data.validityMonths = expires ? ('validityMonths' in body ? months : current?.validityMonths ?? null) : null;
    }
    if ('warnDays' in body) data.warnDays = this.warnDaysOf(body.warnDays) ?? DEFAULT_WARN_DAYS;
    if ('required' in body) data.required = truthy(body.required);
    return data;
  }

  private warnDaysOf(value: unknown): number | null {
    if (blank(value)) return null;
    const days = Number(value);
    if (!Number.isInteger(days) || days < 0 || days > 365) throw new BadRequestException('Aviso: informe de 0 a 365 dias');
    return days;
  }

  async createType(actor: FileActor, body: Body) {
    this.needManage(actor, 'configurar os tipos de documento');
    await this.ensureDefaults(actor.companyId);
    const data = await this.typeData(actor.companyId, body, null);
    return this.presentType(await this.prisma.file_DocumentType.create({ data: { ...(data as Prisma.File_DocumentTypeUncheckedCreateInput), companyId: actor.companyId } }));
  }

  private async typeById(companyId: number, id: number) {
    const type = await this.prisma.file_DocumentType.findFirst({ where: { id, companyId } });
    if (!type) throw new NotFoundException('Tipo de documento não encontrado');
    return type;
  }

  async updateType(actor: FileActor, id: number, body: Body) {
    this.needManage(actor, 'configurar os tipos de documento');
    const type = await this.typeById(actor.companyId, id);
    return this.presentType(await this.prisma.file_DocumentType.update({ where: { id }, data: await this.typeData(actor.companyId, body, type) }));
  }

  /** Tipo inativo não pode mais ser escolhido nem conta como obrigatório; os arquivos que já o usam continuam com ele. */
  async setTypeActive(actor: FileActor, id: number, active: boolean) {
    this.needManage(actor, 'configurar os tipos de documento');
    await this.typeById(actor.companyId, id);
    return this.presentType(await this.prisma.file_DocumentType.update({ where: { id }, data: { inactiveAt: active ? null : new Date() } }));
  }

  // ------------------------------------------------------------------ pastas

  private freeName(tree: Tree, parentId: number | null, name: string, exceptId?: number) {
    return !tree.children(parentId).some((sibling) => sibling.id !== exceptId && !sibling.trashedAt && fold(sibling.name) === fold(name));
  }

  private async accessOf(actor: FileActor, body: Body) {
    const restricted = truthy(body.restricted);
    const profileIds = restricted ? idsOf(body.profileIds) : [];
    if (restricted && !profileIds.length) throw new BadRequestException('Escolha pelo menos um perfil para a pasta restrita');
    if (profileIds.length && (await this.prisma.profile.count({ where: { id: { in: profileIds }, OR: [{ companyId: actor.companyId }, { companyId: null }] } })) !== profileIds.length) throw new BadRequestException('Perfil não encontrado');
    return { restricted, profileIds };
  }

  async createFolder(actor: FileActor, body: Body) {
    this.needWrite(actor);
    const tree = await this.tree(actor);
    const parentId = Number(body.parentId) > 0 ? this.folderOf(tree, Number(body.parentId)).id : null;
    if (!parentId) this.needManage(actor, 'criar pastas no primeiro nível');
    const name = cleanName(body.name, 120);
    if (!name) throw new BadRequestException('Informe o nome da pasta');
    if (!this.freeName(tree, parentId, name)) throw new ConflictException('Já existe uma pasta com este nome aqui');
    if ('restricted' in body) this.needManage(actor, 'definir o acesso das pastas');
    const access = 'restricted' in body ? await this.accessOf(actor, body) : { restricted: false, profileIds: [] };
    const created = await this.prisma.$transaction(async (tx) => {
      const folder = await tx.file_Folder.create({ data: { companyId: actor.companyId, parentId, name, ...access, createdByUserId: actor.userId || null } });
      await recordFlowEvent(tx, FOLDER_ENTITY, { companyId: actor.companyId, entityId: folder.id, type: 'criada', userId: actor.userId, note: name });
      return folder;
    });
    return { id: created.id, parentId: created.parentId, name: created.name };
  }

  /** Renomear, mover ou mudar quem acessa. Pasta do primeiro nível e acesso são de quem administra. */
  async updateFolder(actor: FileActor, id: number, body: Body) {
    this.needWrite(actor);
    const tree = await this.tree(actor);
    const folder = this.folderOf(tree, id);
    if (!folder.parentId) this.needManage(actor, 'alterar pastas do primeiro nível');
    const data: { name?: string; parentId?: number | null; restricted?: boolean; profileIds?: number[] } = {};
    let parentId = folder.parentId;
    if ('parentId' in body) {
      parentId = Number(body.parentId) > 0 ? this.folderOf(tree, Number(body.parentId)).id : null;
      if (parentId !== folder.parentId) {
        if (!parentId) this.needManage(actor, 'mover pastas para o primeiro nível');
        if (parentId && tree.descendants(id).includes(parentId)) throw new BadRequestException('Uma pasta não pode ir para dentro dela mesma');
        data.parentId = parentId;
      }
    }
    const name = 'name' in body ? cleanName(body.name, 120) : folder.name;
    if (!name) throw new BadRequestException('Informe o nome da pasta');
    if (name !== folder.name) data.name = name;
    if (('name' in data || 'parentId' in data) && !this.freeName(tree, parentId, name, id)) throw new ConflictException('Já existe uma pasta com este nome aqui');
    if ('restricted' in body) {
      this.needManage(actor, 'definir o acesso das pastas');
      Object.assign(data, await this.accessOf(actor, body));
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.file_Folder.update({ where: { id }, data });
      if ('parentId' in data) await recordFlowEvent(tx, FOLDER_ENTITY, { companyId: actor.companyId, entityId: id, type: 'movida', userId: actor.userId });
      if ('restricted' in data) await recordFlowEvent(tx, FOLDER_ENTITY, { companyId: actor.companyId, entityId: id, type: 'acesso', userId: actor.userId, note: data.restricted ? `restrita a ${data.profileIds?.length} perfis` : 'aberta a todos' });
    });
    return { id, parentId, name };
  }

  /** A pasta inteira vai para a lixeira: tudo o que está dentro some junto e volta junto. */
  async trashFolder(actor: FileActor, id: number) {
    this.needWrite(actor);
    const tree = await this.tree(actor);
    const folder = this.folderOf(tree, id);
    if (!folder.parentId) this.needManage(actor, 'apagar pastas do primeiro nível');
    await this.prisma.$transaction(async (tx) => {
      await tx.file_Folder.update({ where: { id }, data: { trashedAt: new Date(), trashedByUserId: actor.userId || null } });
      await recordFlowEvent(tx, FOLDER_ENTITY, { companyId: actor.companyId, entityId: id, type: 'lixeira', userId: actor.userId, note: folder.name });
    });
    return { id, parentId: folder.parentId };
  }

  // ------------------------------------------------------------------ arquivos

  /**
   * Tipo, emissão, vencimento e aviso de um arquivo. O que não vem no pedido fica
   * como está. Sem vencimento informado, vale a validade do tipo contada da emissão.
   */
  private async expiryOf(companyId: number, body: Body, current: FileRow | null) {
    let type = current?.type ?? null;
    if ('typeId' in body) {
      type = blank(body.typeId) ? null : await this.prisma.file_DocumentType.findFirst({ where: { id: Number(body.typeId), companyId, inactiveAt: null } });
      if (!blank(body.typeId) && !type) throw new BadRequestException('Tipo de documento não encontrado');
    }
    const issue = 'issueDate' in body ? (blank(body.issueDate) ? null : dateOf(body.issueDate, 'Emissão')) : iso(current?.issueDate) ?? null;
    if (issue && issue > today()) throw new BadRequestException('A emissão não pode ser no futuro');
    let expiry = 'expiryDate' in body ? (blank(body.expiryDate) ? null : dateOf(body.expiryDate, 'Vencimento')) : iso(current?.expiryDate) ?? null;
    if (!expiry && type?.expires && issue && type.validityMonths && ('typeId' in body || 'issueDate' in body)) expiry = suggestedExpiry(issue, type.validityMonths);
    if (type?.expires && !expiry) throw new BadRequestException(`${type.name} tem validade: informe o vencimento`);
    if (issue && expiry && expiry < issue) throw new BadRequestException('O vencimento não pode ser antes da emissão');
    const warnDays = 'warnDays' in body ? this.warnDaysOf(body.warnDays) : current?.warnDays ?? null;
    return { typeId: type?.id ?? null, issueDate: issue ? asDate(issue) : null, expiryDate: expiry ? asDate(expiry) : null, warnDays };
  }

  /** Guarda o arquivo no armazenamento privado e devolve o que vai para a linha do banco. */
  private async store(actor: FileActor, file: UploadedFile | undefined) {
    if (!file?.buffer?.length) throw new BadRequestException('Envie o arquivo');
    if (file.size > FILE_MAX_BYTES) throw new BadRequestException('O arquivo passa de 25 MB');
    const fileName = cleanName(uploadedName(file.originalname), 200) || 'arquivo';
    // a chave não leva o nome do arquivo nem o da pasta: só a empresa e um identificador aleatório
    const fileKey = `files/${actor.companyId}/${randomUUID()}${extensionOf(fileName)}`;
    const sent = String(file.mimetype ?? '').trim().toLowerCase().slice(0, 150);
    const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(sent) ? sent : 'application/octet-stream';
    return { fileName, fileKey, mimeType, size: BigInt(file.size), put: () => this.storage.put(fileKey, file.buffer, mimeType) };
  }

  async upload(actor: FileActor, file: UploadedFile | undefined, body: Body) {
    this.needWrite(actor);
    const tree = await this.tree(actor);
    const folder = this.folderOf(tree, Number(body.folderId));
    const { put, ...stored } = await this.store(actor, file);
    const expiry = await this.expiryOf(actor.companyId, body, null);
    await put();
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.file_Item.create({ data: { companyId: actor.companyId, folderId: folder.id, name: stored.fileName, ...stored, ...expiry, notes: cleanName(body.notes, 500) || null, uploadedByUserId: actor.userId || null }, include: WITH_TYPE });
      await recordFlowEvent(tx, FILE_ENTITY, { companyId: actor.companyId, entityId: row.id, type: 'envio', userId: actor.userId, note: stored.fileName });
      return row;
    });
    return this.presentFile(created, await this.userNames([created.uploadedByUserId]));
  }

  /**
   * Substituir por uma versão nova: o arquivo anterior fica guardado como versão,
   * e o novo herda a pasta, o tipo e a observação. O vencimento é o do novo.
   */
  async replace(actor: FileActor, id: number, file: UploadedFile | undefined, body: Body) {
    this.needWrite(actor);
    const current = await this.fileOf(actor, await this.tree(actor), id);
    const { put, ...stored } = await this.store(actor, file);
    // a validade do novo não herda a do antigo: vem do pedido ou da validade do tipo
    const expiry = await this.expiryOf(actor.companyId, { issueDate: null, expiryDate: null, ...body, typeId: 'typeId' in body ? body.typeId : current.typeId }, null);
    const group = current.versionGroup ?? randomUUID();
    // mantém o nome mostrado quando o tipo de arquivo é o mesmo; se mudou (PDF por imagem), vale o nome do novo
    const name = extensionOf(downloadName(current.name, current.fileName)) === extensionOf(stored.fileName) ? current.name : stored.fileName;
    await put();
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.file_Item.update({ where: { id }, data: { replacedAt: new Date(), versionGroup: group } });
      const row = await tx.file_Item.create({ data: {
        companyId: actor.companyId, folderId: current.folderId, name, ...stored, ...expiry, warnDays: 'warnDays' in body ? expiry.warnDays : current.warnDays,
        notes: 'notes' in body ? cleanName(body.notes, 500) || null : current.notes, versionGroup: group, uploadedByUserId: actor.userId || null,
      }, include: WITH_TYPE });
      await recordFlowEvent(tx, FILE_ENTITY, { companyId: actor.companyId, entityId: row.id, type: 'substituido', userId: actor.userId, note: stored.fileName });
      return row;
    });
    return this.presentFile(created, await this.userNames([created.uploadedByUserId]));
  }

  /** Renomear, mover de pasta, corrigir a observação, o tipo ou as datas. O conteúdo só muda enviando outro arquivo. */
  async updateFile(actor: FileActor, id: number, body: Body) {
    this.needWrite(actor);
    const tree = await this.tree(actor);
    const file = await this.fileOf(actor, tree, id);
    const data: Prisma.File_ItemUncheckedUpdateInput = {};
    let renamed = '';
    let moved = 0;
    if ('name' in body) {
      const name = cleanName(body.name, 200);
      if (!name) throw new BadRequestException('Informe o nome do arquivo');
      if (name !== file.name) { data.name = name; renamed = name; }
    }
    if ('folderId' in body) {
      const target = this.folderOf(tree, Number(body.folderId));
      if (target.id !== file.folderId) moved = target.id;
    }
    if ('notes' in body) data.notes = cleanName(body.notes, 500) || null;
    if (['typeId', 'issueDate', 'expiryDate', 'warnDays'].some((key) => key in body)) Object.assign(data, await this.expiryOf(actor.companyId, body, file));
    const updated = await this.prisma.$transaction(async (tx) => {
      // as versões anteriores acompanham o arquivo quando ele muda de pasta
      if (moved) await tx.file_Item.updateMany({ where: this.groupWhere(file), data: { folderId: moved } });
      const row = await tx.file_Item.update({ where: { id }, data, include: WITH_TYPE });
      if (renamed) await recordFlowEvent(tx, FILE_ENTITY, { companyId: actor.companyId, entityId: id, type: 'renomeado', userId: actor.userId, note: `${file.name} → ${renamed}` });
      if (moved) await recordFlowEvent(tx, FILE_ENTITY, { companyId: actor.companyId, entityId: id, type: 'movido', userId: actor.userId, note: tree.chain(moved).map((item) => item.name).join(' › ') });
      return row;
    });
    return this.presentFile(updated, await this.userNames([updated.uploadedByUserId]));
  }

  /** O arquivo vai para a lixeira com as versões anteriores dele (que voltam junto, se for restaurado). */
  async trashFile(actor: FileActor, id: number) {
    this.needWrite(actor);
    const file = await this.fileOf(actor, await this.tree(actor), id);
    await this.prisma.$transaction(async (tx) => {
      await tx.file_Item.update({ where: { id }, data: { trashedAt: new Date(), trashedByUserId: actor.userId || null } });
      await recordFlowEvent(tx, FILE_ENTITY, { companyId: actor.companyId, entityId: id, type: 'lixeira', userId: actor.userId, note: file.name });
    });
    return { id, folderId: file.folderId };
  }

  /** O arquivo (ou uma versão anterior), para ver ou baixar. Cada acesso fica registrado (quem e quando). */
  async file(actor: FileActor, id: number, download: boolean) {
    const file = await this.fileOf(actor, await this.tree(actor), id, { version: true });
    const body = await this.storage.get(file.fileKey);
    await recordFlowEvent(this.prisma, FILE_ENTITY, { companyId: actor.companyId, entityId: id, type: download ? 'download' : 'visualizado', userId: actor.userId, note: file.replacedAt ? 'versão anterior' : null });
    const inline = !download && opensInline(file.mimeType);
    // o que não é seguro abrir no navegador sai sempre como download, sem tipo que o navegador execute
    return { body, fileName: downloadName(file.name, file.fileName), mimeType: opensInline(file.mimeType) ? file.mimeType : 'application/octet-stream', inline };
  }

  /** Para quem administra: tudo o que aconteceu com o arquivo e com as versões dele (envio, quem abriu, quem baixou, mudanças). */
  async history(actor: FileActor, id: number) {
    this.needManage(actor, 'ver o histórico de acesso');
    const file = await this.prisma.file_Item.findFirst({ where: { id, companyId: actor.companyId } });
    if (!file) throw new NotFoundException('Arquivo não encontrado');
    const ids = (await this.prisma.file_Item.findMany({ where: this.groupWhere(file), select: { id: true } })).map((row) => row.id);
    const events = await this.prisma.flow_Event.findMany({ where: { companyId: actor.companyId, entity: FILE_ENTITY, entityId: { in: ids } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 500 });
    const names = await this.userNames(events.map((event) => event.userId));
    return { file: { id: file.id, name: file.name }, rows: events.map((event) => ({ id: event.id, type: event.type, note: event.note, user: event.userId ? names.get(event.userId) ?? null : null, createdAt: event.createdAt })) };
  }

  /** Para quem administra: apagar de vez uma versão anterior (libera o espaço; o arquivo vigente não muda). */
  async purgeVersion(actor: FileActor, id: number) {
    this.needManage(actor, 'apagar versões anteriores');
    const version = await this.fileOf(actor, await this.tree(actor), id, { version: true });
    if (!version.replacedAt) throw new BadRequestException('Este é o arquivo vigente, não uma versão anterior');
    await this.destroyFiles(actor.companyId, [version], actor.userId);
    return { id };
  }

  // ------------------------------------------------------------------ vencimentos

  /** Tudo o que pede ação: arquivos vencidos e a vencer nas pastas que a pessoa vê, e tipos obrigatórios sem arquivo vigente. */
  private async pending(actor: FileActor): Promise<{ day: string; rows: PendingRow[] }> {
    const day = today();
    const tree = await this.tree(actor);
    const [files, required, typed] = await Promise.all([
      this.prisma.file_Item.findMany({ where: { companyId: actor.companyId, ...CURRENT, expiryDate: { not: null } }, include: WITH_TYPE, orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }], take: 5000 }),
      this.prisma.file_DocumentType.findMany({ where: { companyId: actor.companyId, inactiveAt: null, required: true }, orderBy: { name: 'asc' } }),
      this.prisma.file_Item.findMany({ where: { companyId: actor.companyId, ...CURRENT, typeId: { not: null } }, select: { typeId: true, folderId: true } }),
    ]);
    const where = (id: number) => tree.chain(id).map((item) => item.name).join(' › ');
    const rows: PendingRow[] = [];
    for (const file of files) {
      if (!tree.live(file.folderId) || !tree.allowed(file.folderId)) continue;
      const status = statusOf(file, day);
      if (status === 'em_dia' || status === 'sem_validade') continue;
      const expiry = iso(file.expiryDate)!;
      rows.push({
        key: `f${file.id}`, fileId: file.id, folderId: file.folderId, name: file.name, where: where(file.folderId), typeId: file.typeId, typeName: file.type?.name ?? null,
        status, statusLabel: DOCUMENT_STATUS_LABEL[status], expiryDate: expiry, days: Math.round((asDate(expiry).getTime() - asDate(day).getTime()) / 86400000),
      });
    }
    // "faltando" é da empresa, não de uma pasta: vale para qualquer arquivo vigente, mesmo em pasta que a pessoa não vê
    const have = new Set(typed.filter((file) => tree.all.has(file.folderId) && tree.chain(file.folderId).every((folder) => !folder.trashedAt)).map((file) => file.typeId));
    for (const type of required) if (!have.has(type.id)) {
      rows.push({ key: `t${type.id}`, fileId: null, folderId: null, name: type.name, where: '', typeId: type.id, typeName: type.name, status: 'faltando', statusLabel: DOCUMENT_STATUS_LABEL.faltando, expiryDate: null, days: null });
    }
    return { day, rows };
  }

  async expiring(actor: FileActor, query: Record<string, string>) {
    await this.ensureDefaults(actor.companyId);
    const { day, rows } = await this.pending(actor);
    const summary = { vencido: 0, a_vencer: 0, faltando: 0 };
    for (const row of rows) summary[row.status as keyof typeof summary] += 1;
    const term = fold(cleanName(query.search, 80));
    const typeId = Number(query.typeId) > 0 ? Number(query.typeId) : null;
    const filtered = rows.filter((row) => (!query.status || row.status === query.status) && (!typeId || row.typeId === typeId) && (!term || fold(`${row.name} ${row.typeName ?? ''}`).includes(term)));
    const types = await this.prisma.file_DocumentType.findMany({ where: { companyId: actor.companyId, inactiveAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
    return { today: day, summary, total: filtered.length, rows: filtered.slice(0, 500), types };
  }

  /** Os blocos de documentos da empresa na "Minha esteira". Só existem depois que a empresa abriu os Arquivos uma vez. */
  async pipelineBlocks(actor: FileActor) {
    if (!(await this.prisma.file_DocumentType.count({ where: { companyId: actor.companyId } }))) return [];
    const { rows } = await this.pending(actor);
    const br = (value: string | null) => (value ? value.split('-').reverse().join('/') : '');
    const block = (key: string, status: FolderStatus, title: string, hint: string) => {
      const list = rows.filter((row) => row.status === status);
      return {
        key, area: 'Empresa', title, hint, count: list.length, total: null, link: '/arquivos/vencimentos',
        items: list.slice(0, 5).map((row) => ({
          id: row.fileId ?? row.typeId ?? 0, title: row.typeName ?? row.name, value: null, late: status === 'vencido', link: row.folderId ? `/arquivos/pastas?pasta=${row.folderId}` : '/arquivos/vencimentos',
          subtitle: status === 'faltando' ? 'nenhum arquivo vigente' : `${row.typeName ? `${row.name} · ` : ''}${status === 'vencido' ? 'venceu em' : 'vence em'} ${br(row.expiryDate)}`,
        })),
      };
    };
    return [
      block('arquivos_vencidos', 'vencido', 'Documentos da empresa vencidos', 'Arquivos da empresa com a validade passada'),
      block('arquivos_vencer', 'a_vencer', 'Documentos da empresa a vencer', 'Vencem dentro do prazo de aviso'),
      block('arquivos_faltando', 'faltando', 'Documentos obrigatórios da empresa faltando', 'Tipos obrigatórios sem nenhum arquivo vigente'),
    ];
  }

  // ------------------------------------------------------------------ lixeira

  private daysLeft(trashedAt: Date) { return Math.max(0, TRASH_DAYS - Math.floor((Date.now() - trashedAt.getTime()) / 86400000)); }

  /** O que está na lixeira e a pessoa pode ver: pastas apagadas (com tudo o que têm dentro) e arquivos apagados um a um. */
  async trash(actor: FileActor) {
    await this.purgeExpired(actor.companyId);
    const tree = await this.tree(actor);
    const counts = await this.fileCounts(actor.companyId);
    // pasta apagada dentro de outra pasta apagada volta junto com a de cima: só a de cima aparece
    const folders = [...tree.all.values()].filter((folder) => folder.trashedAt && tree.allowed(folder.id) && (!folder.parentId || tree.live(folder.parentId)));
    const files = (await this.prisma.file_Item.findMany({ where: { companyId: actor.companyId, trashedAt: { not: null }, replacedAt: null }, include: WITH_TYPE, orderBy: [{ trashedAt: 'desc' }, { id: 'desc' }], take: LIST_LIMIT }))
      .filter((file) => tree.allowed(file.folderId) && tree.live(file.folderId));
    const names = await this.userNames([...folders.map((folder) => folder.trashedByUserId), ...files.flatMap((file) => [file.trashedByUserId, file.uploadedByUserId])]);
    const where = (id: number | null) => (id ? tree.chain(id).map((item) => item.name).join(' › ') : 'Arquivos');
    return {
      trashDays: TRASH_DAYS,
      folders: folders.sort((a, b) => b.trashedAt!.getTime() - a.trashedAt!.getTime()).map((folder) => ({
        id: folder.id, name: folder.name, from: where(folder.parentId), trashedAt: folder.trashedAt, trashedBy: folder.trashedByUserId ? names.get(folder.trashedByUserId) ?? null : null,
        daysLeft: this.daysLeft(folder.trashedAt!), files: tree.descendants(folder.id).reduce((sum, id) => sum + (counts.get(id) ?? 0), 0),
      })),
      files: files.map((file) => ({
        ...this.presentFile(file, names), from: where(file.folderId), trashedAt: file.trashedAt, trashedBy: file.trashedByUserId ? names.get(file.trashedByUserId) ?? null : null, daysLeft: this.daysLeft(file.trashedAt!),
      })),
    };
  }

  async restoreFile(actor: FileActor, id: number) {
    this.needWrite(actor);
    const tree = await this.tree(actor);
    const file = await this.fileOf(actor, tree, id, { trashed: true });
    if (!tree.live(file.folderId)) throw new ConflictException('A pasta deste arquivo está na lixeira: restaure a pasta');
    await this.prisma.$transaction(async (tx) => {
      await tx.file_Item.update({ where: { id }, data: { trashedAt: null, trashedByUserId: null } });
      await recordFlowEvent(tx, FILE_ENTITY, { companyId: actor.companyId, entityId: id, type: 'restaurado', userId: actor.userId });
    });
    return { id, folderId: file.folderId };
  }

  private trashedFolder(tree: Tree, id: number): File_Folder {
    const folder = tree.all.get(id);
    if (!folder || !folder.trashedAt || !tree.allowed(id)) throw new NotFoundException('Pasta não encontrada na lixeira');
    return folder;
  }

  async restoreFolder(actor: FileActor, id: number) {
    this.needWrite(actor);
    const tree = await this.tree(actor);
    const folder = this.trashedFolder(tree, id);
    if (!folder.parentId) this.needManage(actor, 'restaurar pastas do primeiro nível');
    if (folder.parentId && !tree.live(folder.parentId)) throw new ConflictException('A pasta de cima está na lixeira: restaure-a primeiro');
    // se nesse meio-tempo nasceu outra com o mesmo nome, a que volta ganha uma marca
    let name = folder.name;
    for (let copy = 1; !this.freeName(tree, folder.parentId, name, id); copy++) name = `${folder.name} (restaurada${copy > 1 ? ` ${copy}` : ''})`.slice(0, 120);
    await this.prisma.$transaction(async (tx) => {
      await tx.file_Folder.update({ where: { id }, data: { trashedAt: null, trashedByUserId: null, name } });
      await recordFlowEvent(tx, FOLDER_ENTITY, { companyId: actor.companyId, entityId: id, type: 'restaurada', userId: actor.userId });
    });
    return { id, parentId: folder.parentId, name };
  }

  /** Apaga de verdade: primeiro o arquivo no armazenamento, depois a linha. Fica o registro de quem apagou. */
  private async destroyFiles(companyId: number, files: File_Item[], userId: number | null) {
    for (const file of files) {
      await this.storage.delete(file.fileKey);
      await this.prisma.$transaction(async (tx) => {
        await tx.file_Item.delete({ where: { id: file.id } });
        await recordFlowEvent(tx, FILE_ENTITY, { companyId, entityId: file.id, type: 'excluido', userId, note: file.replacedAt ? `${file.name} (versão anterior)` : file.name });
      });
    }
  }

  private async destroyFolder(companyId: number, tree: Tree, folder: File_Folder, userId: number | null) {
    const ids = tree.descendants(folder.id);
    // todas as linhas das pastas, inclusive as versões anteriores
    await this.destroyFiles(companyId, await this.prisma.file_Item.findMany({ where: { companyId, folderId: { in: ids } } }), userId);
    await this.prisma.$transaction(async (tx) => {
      // as pastas de dentro vão junto (exclusão em cascata)
      await tx.file_Folder.delete({ where: { id: folder.id } });
      await recordFlowEvent(tx, FOLDER_ENTITY, { companyId, entityId: folder.id, type: 'excluida', userId, note: folder.name });
    });
  }

  async purgeFile(actor: FileActor, id: number) {
    this.needManage(actor, 'apagar de vez');
    const file = await this.fileOf(actor, await this.tree(actor), id, { trashed: true });
    await this.destroyFiles(actor.companyId, await this.prisma.file_Item.findMany({ where: this.groupWhere(file) }), actor.userId);
    return { id };
  }

  async purgeFolder(actor: FileActor, id: number) {
    this.needManage(actor, 'apagar de vez');
    const tree = await this.tree(actor);
    await this.destroyFolder(actor.companyId, tree, this.trashedFolder(tree, id), actor.userId);
    return { id };
  }

  /** O que passou do prazo da lixeira some de verdade. Roda quando alguém abre o módulo, no máximo uma vez por dia. */
  async purgeExpired(companyId: number, force = false): Promise<{ files: number; folders: number }> {
    const day = today();
    if (!force && this.purgedOn.get(companyId) === day) return { files: 0, folders: 0 };
    this.purgedOn.set(companyId, day);
    const cutoff = new Date(Date.now() - TRASH_DAYS * 86400000);
    const tree = await this.tree({ userId: 0, companyId, canWrite: true, canManage: true });
    const folders = [...tree.all.values()].filter((folder) => folder.trashedAt && folder.trashedAt < cutoff);
    // pasta vencida dentro de outra vencida sai com a de cima
    const tops = folders.filter((folder) => !tree.chain(folder.id).some((above) => above.id !== folder.id && folders.includes(above)));
    for (const folder of tops) await this.destroyFolder(companyId, tree, folder, null);
    const files = await this.prisma.file_Item.findMany({ where: { companyId, trashedAt: { lt: cutoff }, replacedAt: null } });
    for (const file of files) await this.destroyFiles(companyId, await this.prisma.file_Item.findMany({ where: this.groupWhere(file) }), null);
    return { files: files.length, folders: tops.length };
  }
}
