import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { File_Folder, File_Item } from '@prisma/client';
import { randomUUID } from 'crypto';
import { recordFlowEvent } from 'src/common/flow/flow';
import { PrivateStorageService } from 'src/common/storage/private-storage.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { DEFAULT_FOLDERS, FILE_MAX_BYTES, TRASH_DAYS, cleanName, downloadName, extensionOf, fold, opensInline, uploadedName } from './file.rules';

/**
 * Arquivos da empresa: pastas livres em árvore e os arquivos dentro delas.
 *
 * O arquivo fica no armazenamento privado e só sai pela API, com a permissão
 * conferida e o acesso registrado. Cada pasta pode ser aberta a todos que usam
 * o módulo ou restrita a alguns perfis; as de dentro seguem a de cima. Apagar
 * manda para a lixeira; depois de 30 dias a linha e o arquivo somem de verdade.
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

const truthy = (value: unknown) => value === true || value === 'true' || value === 1 || value === '1';
const idsOf = (value: unknown): number[] => (Array.isArray(value) ? [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))] : []);
const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

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

  private async fileOf(actor: FileActor, tree: Tree, id: number, trashed = false): Promise<File_Item> {
    const file = await this.prisma.file_Item.findFirst({ where: { id, companyId: actor.companyId } });
    if (!file || !tree.allowed(file.folderId) || !!file.trashedAt !== trashed || (!trashed && !tree.live(file.folderId))) throw new NotFoundException('Arquivo não encontrado');
    return file;
  }

  private needWrite(actor: FileActor) { if (!actor.canWrite && !actor.canManage) throw new ForbiddenException('Seu perfil só pode ver os arquivos'); }
  private needManage(actor: FileActor, what: string) { if (!actor.canManage) throw new ForbiddenException(`Só quem administra os arquivos pode ${what}`); }

  /** A empresa começa com as pastas sugeridas, uma vez só (mesmo que depois apague todas). */
  private async ensureDefaults(actor: FileActor): Promise<void> {
    if (await this.prisma.file_Folder.count({ where: { companyId: actor.companyId } })) return;
    if (await this.prisma.flow_Event.count({ where: { companyId: actor.companyId, entity: FOLDER_ENTITY, type: 'pastas_iniciais' } })) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.file_Folder.createMany({ data: DEFAULT_FOLDERS.map((name) => ({ companyId: actor.companyId, name })) });
      await recordFlowEvent(tx, FOLDER_ENTITY, { companyId: actor.companyId, entityId: 0, type: 'pastas_iniciais' });
    });
  }

  private async userNames(ids: Array<number | null>): Promise<Map<number, string>> {
    const unique = [...new Set(ids.filter((id): id is number => !!id))];
    const users = unique.length ? await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }) : [];
    return new Map(users.map((user) => [user.id, user.name]));
  }

  private presentFile(file: File_Item, names: Map<number, string>) {
    return {
      id: file.id, folderId: file.folderId, name: file.name, fileName: file.fileName, mimeType: file.mimeType, size: Number(file.size), notes: file.notes,
      inline: opensInline(file.mimeType), uploadedBy: file.uploadedByUserId ? names.get(file.uploadedByUserId) ?? null : null, createdAt: file.createdAt,
    };
  }

  private presentFolder(tree: Tree, folder: File_Folder, counts: Map<number, number>) {
    const inside = tree.descendants(folder.id).filter((id) => tree.live(id) && tree.allowed(id));
    return {
      id: folder.id, parentId: folder.parentId, name: folder.name, restricted: folder.restricted, profileIds: idsOf(folder.profileIds),
      // fechada por ela mesma ou por alguma pasta de cima
      locked: tree.chain(folder.id).some((item) => item.restricted),
      files: inside.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0), folders: inside.length - 1,
    };
  }

  private async fileCounts(companyId: number): Promise<Map<number, number>> {
    const rows = await this.prisma.file_Item.groupBy({ by: ['folderId'], where: { companyId, trashedAt: null }, _count: { _all: true } });
    return new Map(rows.map((row) => [row.folderId, row._count._all]));
  }

  // ------------------------------------------------------------------ navegar e buscar

  /** O que há numa pasta (ou no primeiro nível, sem `folderId`): o caminho, as pastas de dentro e os arquivos. */
  async browse(actor: FileActor, folderId: number | null) {
    await this.ensureDefaults(actor);
    await this.purgeExpired(actor.companyId);
    const tree = await this.tree(actor);
    const folder = folderId ? this.folderOf(tree, folderId) : null;
    const [counts, files] = await Promise.all([
      this.fileCounts(actor.companyId),
      folder ? this.prisma.file_Item.findMany({ where: { companyId: actor.companyId, folderId: folder.id, trashedAt: null }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: LIST_LIMIT }) : [],
    ]);
    const names = await this.userNames(files.map((file) => file.uploadedByUserId));
    const folders = tree.children(folder?.id ?? null).filter((child) => !child.trashedAt && tree.allowed(child.id));
    return {
      folder: folder ? this.presentFolder(tree, folder, counts) : null,
      path: folder ? tree.chain(folder.id).map((item) => ({ id: item.id, name: item.name })) : [],
      folders: folders.map((child) => this.presentFolder(tree, child, counts)),
      files: files.map((file) => this.presentFile(file, names)),
      maxBytes: FILE_MAX_BYTES, trashDays: TRASH_DAYS,
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
      where: { companyId: actor.companyId, trashedAt: null, folderId: { in: visible.map((folder) => folder.id) } }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 20000,
    });
    const found = candidates.filter((file) => fold(file.name).includes(term) || fold(file.fileName).includes(term) || (file.notes ? fold(file.notes).includes(term) : false));
    const names = await this.userNames(found.slice(0, SEARCH_LIMIT).map((file) => file.uploadedByUserId));
    return {
      folders: visible.filter((folder) => fold(folder.name).includes(term)).slice(0, SEARCH_LIMIT).map((folder) => ({ id: folder.id, name: folder.name, path: pathOf(folder.id) })),
      files: found.slice(0, SEARCH_LIMIT).map((file) => ({ ...this.presentFile(file, names), path: pathOf(file.folderId) })),
      total: found.length,
    };
  }

  /** Para quem administra: os perfis que podem ser escolhidos no acesso de uma pasta. */
  async profiles(actor: FileActor) {
    this.needManage(actor, 'definir o acesso das pastas');
    const rows = await this.prisma.profile.findMany({ where: { inactiveAt: null, OR: [{ companyId: actor.companyId }, { companyId: null }] }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
    return { rows };
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

  async upload(actor: FileActor, file: UploadedFile | undefined, body: Body) {
    this.needWrite(actor);
    const tree = await this.tree(actor);
    const folder = this.folderOf(tree, Number(body.folderId));
    if (!file?.buffer?.length) throw new BadRequestException('Envie o arquivo');
    if (file.size > FILE_MAX_BYTES) throw new BadRequestException('O arquivo passa de 25 MB');
    const fileName = cleanName(uploadedName(file.originalname), 200) || 'arquivo';
    // a chave não leva o nome do arquivo nem o da pasta: só a empresa e um identificador aleatório
    const fileKey = `files/${actor.companyId}/${randomUUID()}${extensionOf(fileName)}`;
    const sent = String(file.mimetype ?? '').trim().toLowerCase().slice(0, 150);
    const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(sent) ? sent : 'application/octet-stream';
    await this.storage.put(fileKey, file.buffer, mimeType);
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.file_Item.create({ data: {
        companyId: actor.companyId, folderId: folder.id, name: fileName, fileName, fileKey, mimeType, size: BigInt(file.size), notes: cleanName(body.notes, 500) || null, uploadedByUserId: actor.userId || null,
      } });
      await recordFlowEvent(tx, FILE_ENTITY, { companyId: actor.companyId, entityId: row.id, type: 'envio', userId: actor.userId, note: fileName });
      return row;
    });
    return this.presentFile(created, await this.userNames([created.uploadedByUserId]));
  }

  /** Renomear, mover de pasta ou corrigir a observação. O conteúdo só muda enviando outro arquivo. */
  async updateFile(actor: FileActor, id: number, body: Body) {
    this.needWrite(actor);
    const tree = await this.tree(actor);
    const file = await this.fileOf(actor, tree, id);
    const data: { name?: string; folderId?: number; notes?: string | null } = {};
    if ('name' in body) {
      const name = cleanName(body.name, 200);
      if (!name) throw new BadRequestException('Informe o nome do arquivo');
      if (name !== file.name) data.name = name;
    }
    if ('folderId' in body) {
      const target = this.folderOf(tree, Number(body.folderId));
      if (target.id !== file.folderId) data.folderId = target.id;
    }
    if ('notes' in body) data.notes = cleanName(body.notes, 500) || null;
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.file_Item.update({ where: { id }, data });
      if (data.name) await recordFlowEvent(tx, FILE_ENTITY, { companyId: actor.companyId, entityId: id, type: 'renomeado', userId: actor.userId, note: `${file.name} → ${data.name}` });
      if (data.folderId) await recordFlowEvent(tx, FILE_ENTITY, { companyId: actor.companyId, entityId: id, type: 'movido', userId: actor.userId, note: tree.chain(data.folderId).map((item) => item.name).join(' › ') });
      return row;
    });
    return this.presentFile(updated, await this.userNames([updated.uploadedByUserId]));
  }

  async trashFile(actor: FileActor, id: number) {
    this.needWrite(actor);
    const file = await this.fileOf(actor, await this.tree(actor), id);
    await this.prisma.$transaction(async (tx) => {
      await tx.file_Item.update({ where: { id }, data: { trashedAt: new Date(), trashedByUserId: actor.userId || null } });
      await recordFlowEvent(tx, FILE_ENTITY, { companyId: actor.companyId, entityId: id, type: 'lixeira', userId: actor.userId, note: file.name });
    });
    return { id, folderId: file.folderId };
  }

  /** O arquivo, para ver ou baixar. Cada acesso fica registrado (quem e quando). */
  async file(actor: FileActor, id: number, download: boolean) {
    const file = await this.fileOf(actor, await this.tree(actor), id);
    const body = await this.storage.get(file.fileKey);
    await recordFlowEvent(this.prisma, FILE_ENTITY, { companyId: actor.companyId, entityId: id, type: download ? 'download' : 'visualizado', userId: actor.userId });
    const inline = !download && opensInline(file.mimeType);
    // o que não é seguro abrir no navegador sai sempre como download, sem tipo que o navegador execute
    return { body, fileName: downloadName(file.name, file.fileName), mimeType: opensInline(file.mimeType) ? file.mimeType : 'application/octet-stream', inline };
  }

  /** Para quem administra: tudo o que aconteceu com o arquivo (envio, quem abriu, quem baixou, mudanças). */
  async history(actor: FileActor, id: number) {
    this.needManage(actor, 'ver o histórico de acesso');
    const file = await this.prisma.file_Item.findFirst({ where: { id, companyId: actor.companyId } });
    if (!file) throw new NotFoundException('Arquivo não encontrado');
    const events = await this.prisma.flow_Event.findMany({ where: { companyId: actor.companyId, entity: FILE_ENTITY, entityId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 500 });
    const names = await this.userNames(events.map((event) => event.userId));
    return { file: { id: file.id, name: file.name }, rows: events.map((event) => ({ id: event.id, type: event.type, note: event.note, user: event.userId ? names.get(event.userId) ?? null : null, createdAt: event.createdAt })) };
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
    const files = (await this.prisma.file_Item.findMany({ where: { companyId: actor.companyId, trashedAt: { not: null } }, orderBy: [{ trashedAt: 'desc' }, { id: 'desc' }], take: LIST_LIMIT }))
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
    const file = await this.fileOf(actor, tree, id, true);
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
        await recordFlowEvent(tx, FILE_ENTITY, { companyId, entityId: file.id, type: 'excluido', userId, note: file.name });
      });
    }
  }

  private async destroyFolder(companyId: number, tree: Tree, folder: File_Folder, userId: number | null) {
    const ids = tree.descendants(folder.id);
    await this.destroyFiles(companyId, await this.prisma.file_Item.findMany({ where: { companyId, folderId: { in: ids } } }), userId);
    await this.prisma.$transaction(async (tx) => {
      // as pastas de dentro vão junto (exclusão em cascata)
      await tx.file_Folder.delete({ where: { id: folder.id } });
      await recordFlowEvent(tx, FOLDER_ENTITY, { companyId, entityId: folder.id, type: 'excluida', userId, note: folder.name });
    });
  }

  async purgeFile(actor: FileActor, id: number) {
    this.needManage(actor, 'apagar de vez');
    const file = await this.fileOf(actor, await this.tree(actor), id, true);
    await this.destroyFiles(actor.companyId, [file], actor.userId);
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
    const files = await this.prisma.file_Item.findMany({ where: { companyId, trashedAt: { lt: cutoff } } });
    await this.destroyFiles(companyId, files, null);
    return { files: files.length, folders: tops.length };
  }
}
