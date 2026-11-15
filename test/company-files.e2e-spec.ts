import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { CompanyFileService } from 'src/features/files/file.service';
import { cleanName, downloadName, fold, opensInline, uploadedName } from 'src/features/files/file.rules';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Arquivos da empresa: pastas em árvore, envio para o armazenamento privado
 * (memória, na suíte), acesso por pasta, busca, lixeira e exclusão definitiva,
 * tipos de documento, vencimento, versões e os blocos da Minha esteira.
 */
describe('Arquivos da empresa (e2e)', () => {
  const VIEW = ['view_arquivos'];
  const WRITE = [...VIEW, 'update_arquivos'];
  const MANAGE = [...WRITE, 'manage_arquivos'];
  let jwt: JwtService;
  let files: CompanyFileService;
  let userId = 0;

  beforeAll(async () => {
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    files = app.get(CompanyFileService);
  });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });

  const auth = (companyId: number, permissions: string[] = MANAGE, sub = userId) => {
    const payload = { sub, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  const api = () => request(httpServer());
  const PDF = Buffer.from('%PDF-1.4 arquivo de teste');
  const raw = (res: any, done: any) => { const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks))); };

  async function cenario() {
    const db = testDb();
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const root = (await api().get('/company-files/browse').set(auth(company.id)).expect(200)).body;
    const folderId = (name: string) => root.folders.find((folder: any) => folder.name === name).id as number;
    return { db, company, root, folderId };
  }
  const enviar = (companyId: number, folderId: number, permissions?: string[], file: { content: Buffer; name: string; type: string } = { content: PDF, name: 'alvara.pdf', type: 'application/pdf' }, sub?: number) =>
    api().post('/company-files/files').set(auth(companyId, permissions, sub)).field('folderId', String(folderId)).attach('file', file.content, { filename: file.name, contentType: file.type });
  const abrir = async (companyId: number, folderId: number, permissions?: string[], sub?: number) => (await api().get(`/company-files/browse?folderId=${folderId}`).set(auth(companyId, permissions, sub)).expect(200)).body;

  it('regras puras: nomes, busca sem acento e o que abre no navegador', () => {
    expect(cleanName('  Contratos / 2026\\ativos  ', 120)).toBe('Contratos 2026 ativos');
    expect(fold('Licenças e Alvarás')).toBe('licencas e alvaras');
    expect(uploadedName(Buffer.from('relatório.pdf', 'utf8').toString('latin1'))).toBe('relatório.pdf');
    expect(uploadedName('relatorio.pdf')).toBe('relatorio.pdf');
    expect(uploadedName('café.pdf')).toBe('café.pdf'); // já estava certo: não mexe
    expect(opensInline('application/pdf')).toBe(true);
    expect(opensInline('video/mp4')).toBe(true);
    expect(opensInline('text/html')).toBe(false);
    expect(opensInline('image/svg+xml')).toBe(false);
    expect(downloadName('Alvará 2026', 'scan0001.pdf')).toBe('Alvará 2026.pdf');
    expect(downloadName('Alvará 2026.pdf', 'scan0001.PDF')).toBe('Alvará 2026.pdf');
  });

  it('nasce com as pastas sugeridas uma vez só e deixa criar, renomear e mover pastas', async () => {
    const { company, root, folderId, db } = await cenario();
    expect(root.folders.map((folder: any) => folder.name)).toEqual(expect.arrayContaining(['Certidões', 'Contratos', 'Licenças e alvarás', 'Fotos e vídeos', 'Outros']));
    expect(root.folders).toHaveLength(9);
    expect(root.maxBytes).toBe(25 * 1024 * 1024);

    const sub = (await api().post('/company-files/folders').set(auth(company.id, WRITE)).send({ name: 'Clientes', parentId: folderId('Contratos') }).expect(201)).body;
    const deep = (await api().post('/company-files/folders').set(auth(company.id, WRITE)).send({ name: '2026', parentId: sub.id }).expect(201)).body;
    await api().post('/company-files/folders').set(auth(company.id, WRITE)).send({ name: 'clientes', parentId: folderId('Contratos') }).expect(409); // mesmo nome, mesma pasta
    await api().post('/company-files/folders').set(auth(company.id, WRITE)).send({ name: '  ', parentId: folderId('Contratos') }).expect(400);
    await api().post('/company-files/folders').set(auth(company.id, WRITE)).send({ name: 'Nova raiz' }).expect(403); // primeiro nível é de quem administra
    await api().post('/company-files/folders').set(auth(company.id, VIEW)).send({ name: 'X', parentId: sub.id }).expect(403);
    await api().post('/company-files/folders').set(auth(company.id)).send({ name: 'Nova raiz' }).expect(201);

    const inside = await abrir(company.id, deep.id);
    expect(inside.path.map((item: any) => item.name)).toEqual(['Contratos', 'Clientes', '2026']);
    // a pasta de cima conta o que há nas de dentro
    await enviar(company.id, deep.id).expect(201);
    const contratos = (await api().get('/company-files/browse').set(auth(company.id)).expect(200)).body.folders.find((folder: any) => folder.name === 'Contratos');
    expect(contratos).toMatchObject({ files: 1, folders: 2 });

    // mover: não para dentro de si mesma; subpasta pode ir para outra pasta
    await api().put(`/company-files/folders/${sub.id}`).set(auth(company.id)).send({ parentId: deep.id }).expect(400);
    await api().put(`/company-files/folders/${sub.id}`).set(auth(company.id, WRITE)).send({ parentId: folderId('Outros'), name: 'Clientes antigos' }).expect(200);
    expect((await abrir(company.id, deep.id)).path.map((item: any) => item.name)).toEqual(['Outros', 'Clientes antigos', '2026']);
    await api().put(`/company-files/folders/${folderId('Seguros')}`).set(auth(company.id, WRITE)).send({ name: 'Apólices' }).expect(403); // pasta do primeiro nível
    await api().put(`/company-files/folders/${folderId('Seguros')}`).set(auth(company.id)).send({ name: 'Apólices' }).expect(200);

    // apagar todas as pastas não faz as sugeridas renascerem
    await db.file_Folder.deleteMany({ where: { companyId: company.id } });
    expect((await api().get('/company-files/browse').set(auth(company.id)).expect(200)).body.folders).toHaveLength(0);
    // outra empresa não alcança nada desta
    const other = await makeCompany();
    await api().get(`/company-files/browse?folderId=${deep.id}`).set(auth(other.id)).expect(404);
  });

  it('envia qualquer tipo de arquivo, devolve com o acesso registrado e nunca abre HTML no navegador', async () => {
    const { company, folderId, db } = await cenario();
    const pasta = folderId('Licenças e alvarás');
    const sent = (await enviar(company.id, pasta, WRITE, { content: PDF, name: 'alvará de funcionamento.pdf', type: 'application/pdf' }).expect(201)).body;
    expect(sent).toMatchObject({ name: 'alvará de funcionamento.pdf', mimeType: 'application/pdf', size: PDF.length, inline: true, uploadedBy: 'Vendedor Teste' });
    expect(JSON.stringify(sent)).not.toContain('fileKey');
    const row = await db.file_Item.findUniqueOrThrow({ where: { id: sent.id } });
    // a chave no armazenamento não leva o nome do arquivo nem o da pasta
    expect(row.fileKey).toMatch(new RegExp(`^files/${company.id}/[0-9a-f-]{36}\\.pdf$`));

    const seen = await api().get(`/company-files/files/${sent.id}/file`).set(auth(company.id, VIEW)).buffer(true).parse(raw).expect(200);
    expect(seen.headers['content-type']).toContain('application/pdf');
    expect(seen.headers['content-disposition']).toContain('inline');
    expect(seen.headers['cache-control']).toContain('no-store');
    expect((seen.body as Buffer).equals(PDF)).toBe(true);
    const down = await api().get(`/company-files/files/${sent.id}/file?download=1`).set(auth(company.id, VIEW)).buffer(true).parse(raw).expect(200);
    expect(down.headers['content-disposition']).toContain('attachment');
    expect(down.headers['content-disposition']).toContain(encodeURIComponent('alvará de funcionamento.pdf'));
    expect(await db.flow_Event.count({ where: { entity: 'company_file', entityId: sent.id, type: 'visualizado', userId } })).toBe(1);
    expect(await db.flow_Event.count({ where: { entity: 'company_file', entityId: sent.id, type: 'download', userId } })).toBe(1);

    // planilha, HTML e ZIP entram; HTML sai sempre como download, sem tipo executável
    await enviar(company.id, pasta, WRITE, { content: Buffer.from('PK planilha'), name: 'custos.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }).expect(201);
    const html = (await enviar(company.id, pasta, WRITE, { content: Buffer.from('<script>alert(1)</script>'), name: 'pagina.html', type: 'text/html' }).expect(201)).body;
    expect(html.inline).toBe(false);
    const served = await api().get(`/company-files/files/${html.id}/file`).set(auth(company.id, VIEW)).buffer(true).parse(raw).expect(200);
    expect(served.headers['content-type']).toContain('application/octet-stream');
    expect(served.headers['content-disposition']).toContain('attachment');
    expect(served.headers['x-content-type-options']).toBe('nosniff');

    // validações e permissões
    await api().post('/company-files/files').set(auth(company.id, WRITE)).field('folderId', String(pasta)).expect(400); // sem arquivo
    await enviar(company.id, 999999, WRITE).expect(404);
    await enviar(company.id, pasta, VIEW).expect(403);
    await api().get('/company-files/browse').set(auth(company.id, [])).expect(403);
    await api().get(`/company-files/files/${sent.id}/file`).set(auth(company.id, [])).expect(403);
    const other = await makeCompany();
    await api().get(`/company-files/files/${sent.id}/file`).set(auth(other.id)).expect(404);

    // renomear (o download mantém a extensão), mover e o histórico para quem administra
    const renamed = (await api().put(`/company-files/files/${sent.id}`).set(auth(company.id, WRITE)).send({ name: 'Alvará 2026', folderId: folderId('Certidões'), notes: 'Renovar em março' }).expect(200)).body;
    expect(renamed).toMatchObject({ name: 'Alvará 2026', folderId: folderId('Certidões'), notes: 'Renovar em março' });
    const again = await api().get(`/company-files/files/${sent.id}/file?download=1`).set(auth(company.id, VIEW)).buffer(true).parse(raw).expect(200);
    expect(again.headers['content-disposition']).toContain(encodeURIComponent('Alvará 2026.pdf'));
    expect((await abrir(company.id, pasta)).files.map((file: any) => file.name)).toEqual(['custos.xlsx', 'pagina.html']);
    const history = (await api().get(`/company-files/files/${sent.id}/history`).set(auth(company.id)).expect(200)).body;
    expect(history.rows.map((event: any) => event.type)).toEqual(expect.arrayContaining(['envio', 'visualizado', 'download', 'renomeado', 'movido']));
    expect(history.rows.every((event: any) => event.user === 'Vendedor Teste')).toBe(true);
    await api().get(`/company-files/files/${sent.id}/history`).set(auth(company.id, WRITE)).expect(403);
  });

  it('pasta restrita só aparece para os perfis escolhidos, e as de dentro seguem a de cima', async () => {
    const { company, folderId, db } = await cenario();
    const gestao = await db.profile.create({ data: { name: 'Gestão', companyId: company.id } });
    const campo = await db.profile.create({ data: { name: 'Operação - campo', companyId: company.id } });
    const gestor = await makeSeller(company.id, { profileId: gestao.id, name: 'Gestora' });
    const operador = await makeSeller(company.id, { profileId: campo.id, name: 'Operador' });
    const fiscal = folderId('Societário e fiscal');
    const dentro = (await api().post('/company-files/folders').set(auth(company.id)).send({ name: 'Balanços', parentId: fiscal }).expect(201)).body;
    const segredo = (await enviar(company.id, dentro.id, MANAGE, { content: PDF, name: 'balanço 2025.pdf', type: 'application/pdf' }).expect(201)).body;
    const aberto = (await enviar(company.id, folderId('Modelos e padrões'), MANAGE, { content: PDF, name: 'modelo de balanço.pdf', type: 'application/pdf' }).expect(201)).body;

    expect((await api().get('/company-files/profiles').set(auth(company.id)).expect(200)).body.rows.map((row: any) => row.name)).toEqual(['Gestão', 'Operação - campo']);
    await api().get('/company-files/profiles').set(auth(company.id, WRITE)).expect(403);
    // definir o acesso é de quem administra; restrita pede pelo menos um perfil
    await api().put(`/company-files/folders/${fiscal}`).set(auth(company.id, WRITE)).send({ restricted: true, profileIds: [gestao.id] }).expect(403);
    await api().put(`/company-files/folders/${fiscal}`).set(auth(company.id)).send({ restricted: true, profileIds: [] }).expect(400);
    await api().put(`/company-files/folders/${fiscal}`).set(auth(company.id)).send({ restricted: true, profileIds: [999999] }).expect(400);
    await api().put(`/company-files/folders/${fiscal}`).set(auth(company.id)).send({ restricted: true, profileIds: [gestao.id] }).expect(200);

    const nomes = async (sub: number, permissions = WRITE) => (await api().get('/company-files/browse').set(auth(company.id, permissions, sub)).expect(200)).body.folders.map((folder: any) => folder.name);
    expect(await nomes(gestor.id)).toContain('Societário e fiscal');
    expect(await nomes(operador.id)).not.toContain('Societário e fiscal');
    expect(await nomes(operador.id)).toContain('Modelos e padrões');
    // quem administra vê tudo, mesmo fora dos perfis escolhidos
    expect(await nomes(operador.id, MANAGE)).toContain('Societário e fiscal');
    expect((await abrir(company.id, dentro.id, WRITE, gestor.id)).folder).toMatchObject({ restricted: false, locked: true });

    // sem acesso: a pasta, a de dentro e o arquivo respondem como se não existissem
    await api().get(`/company-files/browse?folderId=${fiscal}`).set(auth(company.id, WRITE, operador.id)).expect(404);
    await api().get(`/company-files/browse?folderId=${dentro.id}`).set(auth(company.id, WRITE, operador.id)).expect(404);
    await api().get(`/company-files/files/${segredo.id}/file`).set(auth(company.id, WRITE, operador.id)).expect(404);
    await enviar(company.id, dentro.id, WRITE, undefined, operador.id).expect(404);
    await api().put(`/company-files/files/${aberto.id}`).set(auth(company.id, WRITE, operador.id)).send({ folderId: dentro.id }).expect(404);
    await api().delete(`/company-files/files/${segredo.id}`).set(auth(company.id, WRITE, operador.id)).expect(404);
    await api().get(`/company-files/files/${segredo.id}/file`).set(auth(company.id, WRITE, gestor.id)).expect(200);

    // a busca e a lista de destinos só trazem o que a pessoa vê
    const busca = async (sub: number) => (await api().get('/company-files/search?q=BALANCO').set(auth(company.id, WRITE, sub)).expect(200)).body;
    expect((await busca(gestor.id)).files.map((file: any) => file.name).sort()).toEqual(['balanço 2025.pdf', 'modelo de balanço.pdf']);
    expect((await busca(gestor.id)).folders.map((folder: any) => folder.name)).toEqual(['Balanços']);
    expect((await busca(gestor.id)).files.find((file: any) => file.id === segredo.id).path.map((item: any) => item.name)).toEqual(['Societário e fiscal', 'Balanços']);
    expect((await busca(operador.id)).files.map((file: any) => file.name)).toEqual(['modelo de balanço.pdf']);
    expect((await busca(operador.id)).folders).toEqual([]);
    await api().get('/company-files/search?q=a').set(auth(company.id)).expect(400);
    const destinos = (await api().get('/company-files/folders').set(auth(company.id, WRITE, operador.id)).expect(200)).body.rows.map((row: any) => row.path);
    expect(destinos).not.toContain('Societário e fiscal › Balanços');
    expect((await api().get('/company-files/folders').set(auth(company.id, WRITE, gestor.id)).expect(200)).body.rows.map((row: any) => row.path)).toContain('Societário e fiscal › Balanços');

    // lixeira também respeita o acesso
    await api().delete(`/company-files/files/${segredo.id}`).set(auth(company.id, WRITE, gestor.id)).expect(200);
    expect((await api().get('/company-files/trash').set(auth(company.id, WRITE, operador.id)).expect(200)).body.files).toEqual([]);
    expect((await api().get('/company-files/trash').set(auth(company.id, WRITE, gestor.id)).expect(200)).body.files).toHaveLength(1);
    // abrir de novo a todos
    await api().put(`/company-files/folders/${fiscal}`).set(auth(company.id)).send({ restricted: false }).expect(200);
    expect(await nomes(operador.id)).toContain('Societário e fiscal');
  });

  it('lixeira: arquivo e pasta somem, voltam, e só quem administra apaga de vez', async () => {
    const { company, folderId, db } = await cenario();
    const contratos = folderId('Contratos');
    const sub = (await api().post('/company-files/folders').set(auth(company.id)).send({ name: 'Clientes', parentId: contratos }).expect(201)).body;
    const a = (await enviar(company.id, contratos, WRITE, { content: Buffer.from('A'), name: 'a.pdf', type: 'application/pdf' }).expect(201)).body;
    const b = (await enviar(company.id, sub.id, WRITE, { content: Buffer.from('B'), name: 'b.pdf', type: 'application/pdf' }).expect(201)).body;

    await api().delete(`/company-files/files/${a.id}`).set(auth(company.id, VIEW)).expect(403);
    await api().delete(`/company-files/files/${a.id}`).set(auth(company.id, WRITE)).expect(200);
    expect((await abrir(company.id, contratos)).files).toEqual([]);
    await api().get(`/company-files/files/${a.id}/file`).set(auth(company.id)).expect(404); // na lixeira não abre
    await api().get('/company-files/trash').set(auth(company.id, VIEW)).expect(403);
    let trash = (await api().get('/company-files/trash').set(auth(company.id, WRITE)).expect(200)).body;
    expect(trash.files).toHaveLength(1);
    expect(trash.files[0]).toMatchObject({ name: 'a.pdf', from: 'Contratos', daysLeft: 30, trashedBy: 'Vendedor Teste' });

    // a pasta vai com o que tem dentro e some da navegação e da busca
    await api().delete(`/company-files/folders/${sub.id}`).set(auth(company.id, WRITE)).expect(200);
    await api().get(`/company-files/browse?folderId=${sub.id}`).set(auth(company.id)).expect(404);
    await api().get(`/company-files/files/${b.id}/file`).set(auth(company.id)).expect(404);
    expect((await api().get('/company-files/search?q=b.pdf').set(auth(company.id)).expect(200)).body.files).toEqual([]);
    trash = (await api().get('/company-files/trash').set(auth(company.id, WRITE)).expect(200)).body;
    expect(trash.folders).toHaveLength(1);
    expect(trash.folders[0]).toMatchObject({ name: 'Clientes', from: 'Contratos', files: 1 });
    await api().delete(`/company-files/folders/${contratos}`).set(auth(company.id, WRITE)).expect(403); // pasta do primeiro nível

    // restaurar: o arquivo volta para a pasta; a pasta volta com o conteúdo, e ganha uma marca se o nome foi ocupado
    await api().post(`/company-files/files/${a.id}/restore`).set(auth(company.id, WRITE)).expect(201);
    expect((await abrir(company.id, contratos)).files.map((file: any) => file.name)).toEqual(['a.pdf']);
    await api().post('/company-files/folders').set(auth(company.id)).send({ name: 'Clientes', parentId: contratos }).expect(201);
    const back = (await api().post(`/company-files/folders/${sub.id}/restore`).set(auth(company.id, WRITE)).expect(201)).body;
    expect(back.name).toBe('Clientes (restaurada)');
    expect((await abrir(company.id, sub.id)).files.map((file: any) => file.name)).toEqual(['b.pdf']);
    await api().post(`/company-files/files/${a.id}/restore`).set(auth(company.id, WRITE)).expect(404); // não está mais na lixeira

    // apagar de vez: só da lixeira, só quem administra, e o arquivo sai do armazenamento
    await api().delete(`/company-files/files/${a.id}/purge`).set(auth(company.id)).expect(404); // não está na lixeira
    await api().delete(`/company-files/files/${a.id}`).set(auth(company.id, WRITE)).expect(200);
    await api().delete(`/company-files/files/${a.id}/purge`).set(auth(company.id, WRITE)).expect(403);
    const keyA = (await db.file_Item.findUniqueOrThrow({ where: { id: a.id } })).fileKey;
    await api().delete(`/company-files/files/${a.id}/purge`).set(auth(company.id)).expect(200);
    expect(await db.file_Item.count({ where: { id: a.id } })).toBe(0);
    await expect((files as any).storage.get(keyA)).rejects.toThrow();
    expect(await db.flow_Event.count({ where: { entity: 'company_file', entityId: a.id, type: 'excluido', userId } })).toBe(1);

    const keyB = (await db.file_Item.findUniqueOrThrow({ where: { id: b.id } })).fileKey;
    await api().delete(`/company-files/folders/${sub.id}`).set(auth(company.id, WRITE)).expect(200);
    await api().delete(`/company-files/folders/${sub.id}/purge`).set(auth(company.id)).expect(200);
    expect(await db.file_Folder.count({ where: { id: sub.id } })).toBe(0);
    expect(await db.file_Item.count({ where: { id: b.id } })).toBe(0);
    await expect((files as any).storage.get(keyB)).rejects.toThrow();
  });

  it('o que passa de 30 dias na lixeira some sozinho; o resto fica', async () => {
    const { company, folderId, db } = await cenario();
    const outros = folderId('Outros');
    const velha = (await api().post('/company-files/folders').set(auth(company.id)).send({ name: 'Velha', parentId: outros }).expect(201)).body;
    const dentro = (await enviar(company.id, velha.id, WRITE, { content: Buffer.from('1'), name: 'dentro.pdf', type: 'application/pdf' }).expect(201)).body;
    const antigo = (await enviar(company.id, outros, WRITE, { content: Buffer.from('2'), name: 'antigo.pdf', type: 'application/pdf' }).expect(201)).body;
    const recente = (await enviar(company.id, outros, WRITE, { content: Buffer.from('3'), name: 'recente.pdf', type: 'application/pdf' }).expect(201)).body;
    const fica = (await enviar(company.id, outros, WRITE, { content: Buffer.from('4'), name: 'fica.pdf', type: 'application/pdf' }).expect(201)).body;
    const ago = (days: number) => new Date(Date.now() - days * 86400000);
    await db.file_Folder.update({ where: { id: velha.id }, data: { trashedAt: ago(31) } });
    await db.file_Item.update({ where: { id: antigo.id }, data: { trashedAt: ago(40) } });
    await db.file_Item.update({ where: { id: recente.id }, data: { trashedAt: ago(29) } });

    expect(await files.purgeExpired(company.id, true)).toEqual({ files: 1, folders: 1 });
    expect(await db.file_Folder.count({ where: { id: velha.id } })).toBe(0);
    expect((await db.file_Item.findMany({ where: { companyId: company.id }, orderBy: { id: 'asc' } })).map((row) => row.id)).toEqual([recente.id, fica.id]);
    expect(await db.flow_Event.count({ where: { entity: 'company_file', type: 'excluido', entityId: { in: [dentro.id, antigo.id] } } })).toBe(2);
    const trash = (await api().get('/company-files/trash').set(auth(company.id, WRITE)).expect(200)).body;
    expect(trash.files.map((file: any) => [file.name, file.daysLeft])).toEqual([['recente.pdf', 1]]);
  });

  it('tipos de documento: nasce com a lista padrão e só quem administra cria, edita e inativa', async () => {
    const { company } = await cenario();
    const types = (await api().get('/company-files/types').set(auth(company.id, VIEW)).expect(200)).body.rows;
    expect(types.map((type: any) => type.name)).toEqual(expect.arrayContaining(['Alvará de funcionamento', 'PGR', 'PCMSO', 'CND federal', 'Apólice de seguro']));
    expect(types.find((type: any) => type.name === 'PGR')).toMatchObject({ expires: true, validityMonths: 24, warnDays: 30, required: false });
    expect(types.find((type: any) => type.name === 'Contrato social')).toMatchObject({ expires: false, validityMonths: null });

    const created = (await api().post('/company-files/types').set(auth(company.id)).send({ name: 'Licença ambiental', expires: true, validityMonths: 48, warnDays: 90, required: true }).expect(201)).body;
    expect(created).toMatchObject({ validityMonths: 48, warnDays: 90, required: true });
    await api().post('/company-files/types').set(auth(company.id)).send({ name: 'pgr' }).expect(409);
    await api().post('/company-files/types').set(auth(company.id)).send({ name: 'X' }).expect(400);
    await api().post('/company-files/types').set(auth(company.id)).send({ name: 'Outro', expires: true, validityMonths: 999 }).expect(400);
    await api().post('/company-files/types').set(auth(company.id, WRITE)).send({ name: 'Sem permissão' }).expect(403);
    const edited = (await api().put(`/company-files/types/${created.id}`).set(auth(company.id)).send({ expires: false }).expect(200)).body;
    expect(edited).toMatchObject({ expires: false, validityMonths: null });
    await api().patch(`/company-files/types/${created.id}/inactive`).set(auth(company.id)).expect(200);
    expect((await api().get('/company-files/types').set(auth(company.id)).expect(200)).body.rows.some((type: any) => type.id === created.id)).toBe(false);
    expect((await api().get('/company-files/types?inactive=true').set(auth(company.id)).expect(200)).body.rows.some((type: any) => type.id === created.id)).toBe(true);
    const other = await makeCompany();
    await api().put(`/company-files/types/${created.id}`).set(auth(other.id)).send({ name: 'Invasão' }).expect(404);
  });

  it('vencimento: sugerido pelo tipo, corrigível, pinta a pasta e aparece em Vencimentos e na Minha esteira', async () => {
    const { company, folderId, db } = await cenario();
    const day = (offset: number) => new Date(Date.now() - 3 * 3600 * 1000 + offset * 86400000).toISOString().slice(0, 10);
    const types = (await api().get('/company-files/types').set(auth(company.id)).expect(200)).body.rows;
    const typeId = (name: string) => types.find((type: any) => type.name === name).id as number;
    const seguranca = folderId('Segurança do trabalho');
    const fiscal = folderId('Societário e fiscal');
    const campo = await db.profile.create({ data: { name: 'Operação - campo', companyId: company.id } });
    const gestao = await db.profile.create({ data: { name: 'Gestão', companyId: company.id } });
    const operador = await makeSeller(company.id, { profileId: campo.id, name: 'Operador' });
    await api().put(`/company-files/folders/${fiscal}`).set(auth(company.id)).send({ restricted: true, profileIds: [gestao.id] }).expect(200);

    // envio já com tipo e emissão: PCMSO vale 12 meses, emitido há 400 dias, nasce vencido
    const pcmso = (await enviar(company.id, seguranca, WRITE).field('typeId', String(typeId('PCMSO'))).field('issueDate', day(-400)).expect(201)).body;
    expect(pcmso).toMatchObject({ typeName: 'PCMSO', issueDate: day(-400), status: 'vencido', statusLabel: 'Vencido' });
    // arquivo sem tipo: recebe o tipo e as datas depois; PGR vale 24 meses
    const pgr = (await enviar(company.id, seguranca, WRITE, { content: PDF, name: 'pgr.pdf', type: 'application/pdf' }).expect(201)).body;
    expect(pgr).toMatchObject({ typeId: null, expiryDate: null, status: 'sem_validade' });
    await api().put(`/company-files/files/${pgr.id}`).set(auth(company.id, WRITE)).send({ typeId: typeId('PGR') }).expect(400); // tem validade e não veio data
    await api().put(`/company-files/files/${pgr.id}`).set(auth(company.id, WRITE)).send({ typeId: typeId('PGR'), issueDate: day(5) }).expect(400); // emissão no futuro
    await api().put(`/company-files/files/${pgr.id}`).set(auth(company.id, WRITE)).send({ typeId: 999999 }).expect(400);
    const typed = (await api().put(`/company-files/files/${pgr.id}`).set(auth(company.id, WRITE)).send({ typeId: typeId('PGR'), issueDate: day(-710) }).expect(200)).body;
    expect(typed).toMatchObject({ typeName: 'PGR', status: 'a_vencer' }); // vence em ~20 dias, aviso de 30
    await api().put(`/company-files/files/${pgr.id}`).set(auth(company.id, WRITE)).send({ expiryDate: day(-720) }).expect(400); // antes da emissão
    // aviso próprio do arquivo: com 10 dias de aviso, 20 dias ainda é "em dia"
    expect((await api().put(`/company-files/files/${pgr.id}`).set(auth(company.id, WRITE)).send({ warnDays: 10 }).expect(200)).body.status).toBe('em_dia');
    expect((await api().put(`/company-files/files/${pgr.id}`).set(auth(company.id, WRITE)).send({ warnDays: '' }).expect(200)).body.status).toBe('a_vencer');
    // vencimento direto, sem tipo, numa pasta restrita
    const apolice = (await enviar(company.id, fiscal, MANAGE, { content: PDF, name: 'apólice.pdf', type: 'application/pdf' }).field('expiryDate', day(-3)).expect(201)).body;
    expect(apolice).toMatchObject({ typeId: null, status: 'vencido' });
    await enviar(company.id, seguranca, WRITE, { content: PDF, name: 'ltcat.pdf', type: 'application/pdf' }).field('typeId', String(typeId('LTCAT'))).expect(201); // tipo sem validade

    // a pasta leva o pior caso do que a pessoa vê dentro dela
    const root = (await api().get('/company-files/browse').set(auth(company.id)).expect(200)).body;
    const status = (name: string) => root.folders.find((folder: any) => folder.name === name).status;
    expect(status('Segurança do trabalho')).toBe('vencido');
    expect(status('Societário e fiscal')).toBe('vencido');
    expect(status('Contratos')).toBe('vazia');
    expect(root.types.length).toBeGreaterThan(10);

    // obrigatório sem arquivo vigente acusa "faltando"; tipo com arquivo vigente não
    await api().put(`/company-files/types/${typeId('Alvará de funcionamento')}`).set(auth(company.id)).send({ required: true }).expect(200);
    await api().put(`/company-files/types/${typeId('PGR')}`).set(auth(company.id)).send({ required: true }).expect(200);
    const list = (await api().get('/company-files/expiring').set(auth(company.id)).expect(200)).body;
    expect(list.summary).toEqual({ vencido: 2, a_vencer: 1, faltando: 1 });
    const of = (body: any, wanted: string) => body.rows.filter((row: any) => row.status === wanted).map((row: any) => row.name).sort();
    expect(of(list, 'vencido')).toEqual(['alvara.pdf', 'apólice.pdf']);
    expect(of(list, 'a_vencer')).toEqual(['pgr.pdf']);
    expect(of(list, 'faltando')).toEqual(['Alvará de funcionamento']);
    expect(list.rows.find((row: any) => row.name === 'alvara.pdf')).toMatchObject({ typeName: 'PCMSO', where: 'Segurança do trabalho', days: expect.any(Number) });
    expect((await api().get('/company-files/expiring?status=vencido').set(auth(company.id)).expect(200)).body.total).toBe(2);
    expect((await api().get(`/company-files/expiring?typeId=${typeId('PGR')}`).set(auth(company.id)).expect(200)).body.total).toBe(1);
    expect((await api().get('/company-files/expiring?search=APOLICE').set(auth(company.id)).expect(200)).body.total).toBe(1);
    // quem não entra na pasta restrita não vê o vencido de lá, mas vê o "faltando" (é da empresa)
    const partial = (await api().get('/company-files/expiring').set(auth(company.id, VIEW, operador.id)).expect(200)).body;
    expect(partial.summary).toEqual({ vencido: 1, a_vencer: 1, faltando: 1 });
    expect(JSON.stringify(partial.rows)).not.toContain('apólice');

    // Minha esteira: três blocos da Empresa para quem vê os arquivos; nenhum para quem não vê
    const blocks = async (permissions: string[], sub?: number) => Object.fromEntries((await api().get('/my-pipeline').set(auth(company.id, permissions, sub)).expect(200)).body.blocks.filter((block: any) => block.area === 'Empresa').map((block: any) => [block.key, block.count]));
    expect(await blocks(MANAGE)).toEqual({ arquivos_vencidos: 2, arquivos_vencer: 1, arquivos_faltando: 1 });
    expect(await blocks(VIEW, operador.id)).toEqual({ arquivos_vencidos: 1, arquivos_vencer: 1, arquivos_faltando: 1 });
    expect(await blocks([])).toEqual({});

    // arquivo na lixeira deixa de contar; tipo inativo deixa de ser cobrado
    await api().delete(`/company-files/files/${pcmso.id}`).set(auth(company.id, WRITE)).expect(200);
    await api().delete(`/company-files/files/${pgr.id}`).set(auth(company.id, WRITE)).expect(200);
    await api().patch(`/company-files/types/${typeId('Alvará de funcionamento')}/inactive`).set(auth(company.id)).expect(200);
    const after = (await api().get('/company-files/expiring').set(auth(company.id)).expect(200)).body;
    expect(after.summary).toEqual({ vencido: 1, a_vencer: 0, faltando: 1 });
    expect(of(after, 'faltando')).toEqual(['PGR']);
  });

  it('versões: substituir guarda o anterior, que continua disponível e acompanha o arquivo', async () => {
    const { company, folderId, db } = await cenario();
    const day = (offset: number) => new Date(Date.now() - 3 * 3600 * 1000 + offset * 86400000).toISOString().slice(0, 10);
    const types = (await api().get('/company-files/types').set(auth(company.id)).expect(200)).body.rows;
    const pcmsoType = types.find((type: any) => type.name === 'PCMSO').id as number;
    const pasta = folderId('Segurança do trabalho');
    const trocar = (id: number, content: string, name: string, permissions?: string[]) =>
      api().post(`/company-files/files/${id}/replace`).set(auth(company.id, permissions ?? WRITE)).attach('file', Buffer.from(content), { filename: name, contentType: 'application/pdf' });

    const v1 = (await enviar(company.id, pasta, WRITE, { content: Buffer.from('v1'), name: 'pcmso 2025.pdf', type: 'application/pdf' }).field('typeId', String(pcmsoType)).field('issueDate', day(-400)).field('notes', 'Clínica X').expect(201)).body;
    await api().put(`/company-files/files/${v1.id}`).set(auth(company.id, WRITE)).send({ name: 'PCMSO' }).expect(200);
    await trocar(v1.id, 'v2', 'pcmso 2026.pdf', VIEW).field('issueDate', day(-10)).expect(403);
    await trocar(v1.id, 'v2', 'pcmso 2026.pdf').expect(400); // PCMSO tem validade: o novo precisa de data
    await api().post(`/company-files/files/${v1.id}/replace`).set(auth(company.id, WRITE)).field('issueDate', day(-10)).expect(400); // sem arquivo
    const v2 = (await trocar(v1.id, 'v2', 'pcmso 2026.pdf').field('issueDate', day(-10)).expect(201)).body;
    // herda o nome mostrado, o tipo e a observação; a validade é a do novo
    expect(v2).toMatchObject({ name: 'PCMSO', fileName: 'pcmso 2026.pdf', typeName: 'PCMSO', notes: 'Clínica X', issueDate: day(-10), status: 'em_dia' });
    const v3 = (await trocar(v2.id, 'v3', 'pcmso 2026 revisado.pdf').field('issueDate', day(-1)).expect(201)).body;

    const listed = (await abrir(company.id, pasta)).files;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: v3.id, name: 'PCMSO', status: 'em_dia' });
    expect(listed[0].versions.map((version: any) => [version.id, version.fileName, version.status])).toEqual([[v2.id, 'pcmso 2026.pdf', 'em_dia'], [v1.id, 'pcmso 2025.pdf', 'vencido']]);
    expect((await abrir(company.id, pasta)).folder.files).toBe(1); // versões não contam como arquivos
    // o vencido que ficou para trás não aparece em Vencimentos
    expect((await api().get('/company-files/expiring').set(auth(company.id)).expect(200)).body.summary.vencido).toBe(0);

    // a versão anterior abre, mas não é alterada nem substituída
    const old = await api().get(`/company-files/files/${v1.id}/file?download=1`).set(auth(company.id, VIEW)).buffer(true).parse(raw).expect(200);
    expect((old.body as Buffer).toString()).toBe('v1');
    await api().put(`/company-files/files/${v1.id}`).set(auth(company.id, WRITE)).send({ name: 'Outro' }).expect(404);
    await api().delete(`/company-files/files/${v1.id}`).set(auth(company.id, WRITE)).expect(404);
    await trocar(v1.id, 'x', 'x.pdf').field('issueDate', day(-1)).expect(404);

    // mover leva as versões junto; o histórico junta tudo
    await api().put(`/company-files/files/${v3.id}`).set(auth(company.id, WRITE)).send({ folderId: folderId('Outros') }).expect(200);
    expect((await db.file_Item.findMany({ where: { companyId: company.id } })).every((row) => row.folderId === folderId('Outros'))).toBe(true);
    const history = (await api().get(`/company-files/files/${v3.id}/history`).set(auth(company.id)).expect(200)).body.rows.map((event: any) => event.type);
    expect(history).toEqual(expect.arrayContaining(['envio', 'renomeado', 'substituido', 'download', 'movido']));

    // apagar uma versão anterior: só quem administra, e nunca o vigente
    await api().delete(`/company-files/files/${v1.id}/version`).set(auth(company.id, WRITE)).expect(403);
    await api().delete(`/company-files/files/${v3.id}/version`).set(auth(company.id)).expect(400);
    const keyV1 = (await db.file_Item.findUniqueOrThrow({ where: { id: v1.id } })).fileKey;
    await api().delete(`/company-files/files/${v1.id}/version`).set(auth(company.id)).expect(200);
    await expect((files as any).storage.get(keyV1)).rejects.toThrow();
    expect((await abrir(company.id, folderId('Outros'))).files[0].versions.map((version: any) => version.id)).toEqual([v2.id]);

    // lixeira: o arquivo vai e volta com as versões; apagar de vez leva todas
    await api().delete(`/company-files/files/${v3.id}`).set(auth(company.id, WRITE)).expect(200);
    expect((await api().get('/company-files/trash').set(auth(company.id, WRITE)).expect(200)).body.files.map((file: any) => file.id)).toEqual([v3.id]);
    await api().get(`/company-files/files/${v2.id}/file`).set(auth(company.id)).expect(200); // a versão segue guardada
    await api().post(`/company-files/files/${v3.id}/restore`).set(auth(company.id, WRITE)).expect(201);
    expect((await abrir(company.id, folderId('Outros'))).files[0].versions).toHaveLength(1);
    await api().delete(`/company-files/files/${v3.id}`).set(auth(company.id, WRITE)).expect(200);
    await api().delete(`/company-files/files/${v3.id}/purge`).set(auth(company.id)).expect(200);
    expect(await db.file_Item.count({ where: { companyId: company.id } })).toBe(0);
  });
});
