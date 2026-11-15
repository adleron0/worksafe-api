import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { inflateRawSync } from 'zlib';
import { documentStatus, suggestedExpiry, worstStatus } from 'src/features/hr/document.rules';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Documentos de funcionário (RH): tipos configuráveis, envio para o armazenamento
 * privado (memória, na suíte), versões, vencimentos, obrigatórios e a Minha esteira.
 */
/** Lê os arquivos de um ZIP (só o que o gerador da API produz: guardado ou deflate). */
function unzip(zip: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + size);
    out[name] = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return out;
}

describe('Documentos de funcionário (e2e)', () => {
  const VIEW = ['list_funcionarios', 'view_funcionarios', 'view_documentos_funcionarios'];
  const RH = [...VIEW, 'create_funcionarios', 'update_funcionarios', 'update_documentos_funcionarios'];
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => {
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });

  const auth = (companyId: number, permissions: string[] = RH) => {
    const payload = { sub: userId, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  const api = () => request(httpServer());
  const day = (offset: number) => new Date(Date.now() - 3 * 3600 * 1000 + offset * 86400000).toISOString().slice(0, 10);
  const PDF = Buffer.from('%PDF-1.4 documento de teste');

  async function cenario() {
    const db = testDb();
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const alpinista = await db.commercial_Professional.create({ data: { companyId: company.id, name: 'Alpinista N2', salary: 4200 } });
    const employee = (await api().post('/employees').set(auth(company.id)).send({ name: 'José da Silva', roles: [alpinista.id] }).expect(201)).body;
    const types = (await api().get('/hr-documents/types').set(auth(company.id)).expect(200)).body.rows as Array<{ id: number; name: string }>;
    const typeId = (name: string) => types.find((type) => type.name === name)!.id;
    return { db, company, alpinista, employee, types, typeId };
  }
  const enviar = (companyId: number, employeeId: number, fields: Record<string, string | number>, permissions?: string[], file: { content: Buffer; name: string; type: string } = { content: PDF, name: 'aso.pdf', type: 'application/pdf' }) => {
    let call = api().post(`/hr-documents/employee/${employeeId}`).set(auth(companyId, permissions));
    for (const [key, value] of Object.entries(fields)) call = call.field(key, String(value));
    return call.attach('file', file.content, { filename: file.name, contentType: file.type });
  };
  const pasta = (body: any, id: string) => body.folders.find((folder: any) => folder.id === id);

  it('regras puras: situação pelo vencimento, validade sugerida e o pior sinal', () => {
    expect(documentStatus(null, 30, '2026-11-15')).toBe('sem_validade');
    expect(documentStatus('2026-11-14', 30, '2026-11-15')).toBe('vencido');
    expect(documentStatus('2026-11-15', 30, '2026-11-15')).toBe('a_vencer');
    expect(documentStatus('2026-12-15', 30, '2026-11-15')).toBe('a_vencer');
    expect(documentStatus('2026-12-16', 30, '2026-11-15')).toBe('em_dia');
    expect(suggestedExpiry('2026-01-31', 1)).toBe('2026-02-28');
    expect(suggestedExpiry('2026-11-15', 12)).toBe('2027-11-15');
    expect(suggestedExpiry('2026-11-15', 24)).toBe('2028-11-15');
    expect(worstStatus(['em_dia', 'a_vencer', 'faltando'])).toBe('faltando');
    expect(worstStatus(['em_dia', 'vencido', 'faltando'])).toBe('vencido');
    expect(worstStatus([])).toBe('vazia');
  });

  it('nasce com os tipos padrão e deixa criar, editar e inativar tipos', async () => {
    const { company, types, alpinista } = await cenario();
    expect(types.map((type) => type.name)).toEqual(expect.arrayContaining(['ASO', 'NR-35', 'NR-33', 'Ficha de registro', 'CNH']));
    const aso = (types as any[]).find((type) => type.name === 'ASO');
    expect(aso).toMatchObject({ folder: 'saude', expires: true, validityMonths: 12, required: true, inIntegration: true });

    const created = await api().post('/hr-documents/types').set(auth(company.id)).send({ name: 'Certificado de alpinismo', folder: 'treinamentos', expires: true, validityMonths: 36, required: true, requiredProfessionalIds: [alpinista.id] }).expect(201);
    expect(created.body).toMatchObject({ folder: 'treinamentos', validityMonths: 36, requiredProfessionalIds: [alpinista.id] });
    await api().post('/hr-documents/types').set(auth(company.id)).send({ name: 'aso' }).expect(409); // nome repetido
    await api().post('/hr-documents/types').set(auth(company.id)).send({ name: 'X', folder: 'xpto' }).expect(400);
    await api().post('/hr-documents/types').set(auth(company.id)).send({ name: 'Sem permissão' }).set(auth(company.id, VIEW)).expect(403);
    // tirar a validade zera os meses
    const edited = await api().put(`/hr-documents/types/${created.body.id}`).set(auth(company.id)).send({ expires: false }).expect(200);
    expect(edited.body).toMatchObject({ expires: false, validityMonths: null });
    await api().patch(`/hr-documents/types/${created.body.id}/inactive`).set(auth(company.id)).expect(200);
    const after = (await api().get('/hr-documents/types').set(auth(company.id)).expect(200)).body.rows;
    expect(after.some((type: any) => type.name === 'Certificado de alpinismo')).toBe(false);
  });

  it('envia para a pasta, sugere o vencimento, guarda a versão anterior e devolve o arquivo', async () => {
    const { company, employee, typeId, db } = await cenario();
    const first = await enviar(company.id, employee.id, { typeId: typeId('ASO'), issueDate: day(-400) }).expect(201);
    const saude = pasta(first.body, 'saude');
    expect(saude.count).toBe(1);
    // ASO vale 12 meses: emitido há 400 dias, está vencido
    expect(saude.documents[0]).toMatchObject({ typeName: 'ASO', status: 'vencido', fileName: 'aso.pdf' });
    expect(saude.status).toBe('vencido');
    expect(JSON.stringify(first.body)).not.toContain('fileKey');

    const second = await enviar(company.id, employee.id, { typeId: typeId('ASO'), issueDate: day(-10), notes: 'Periódico' }).expect(201);
    const current = pasta(second.body, 'saude').documents[0];
    expect(current.status).toBe('em_dia');
    expect(current.versions).toHaveLength(1);
    expect(pasta(second.body, 'saude').count).toBe(1);
    // a chave no armazenamento não leva nome nem CPF
    const rows = await db.hr_EmployeeDocument.findMany({ where: { employeeId: employee.id } });
    expect(rows.every((row) => /^hr\/\d+\/\d+\/[0-9a-f-]{36}\.pdf$/.test(row.fileKey))).toBe(true);

    const file = await api().get(`/hr-documents/${current.id}/file`).set(auth(company.id, VIEW)).buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks))); }).expect(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    expect(file.headers['cache-control']).toContain('no-store');
    expect((file.body as Buffer).equals(PDF)).toBe(true);
    // cada acesso fica registrado
    expect(await db.flow_Event.count({ where: { entity: 'hr_document', entityId: current.id, type: 'download', userId } })).toBe(1);

    // tirar o vigente devolve a versão anterior
    const removed = await api().delete(`/hr-documents/${current.id}`).set(auth(company.id)).expect(200);
    expect(pasta(removed.body, 'saude').documents[0]).toMatchObject({ status: 'vencido', versions: [] });
    await api().get(`/hr-documents/${current.id}/file`).set(auth(company.id)).expect(404);
  });

  it('valida o envio e as permissões', async () => {
    const { company, employee, typeId } = await cenario();
    await enviar(company.id, employee.id, { typeId: typeId('ASO') }).expect(400); // tem validade e não veio data
    await enviar(company.id, employee.id, { typeId: typeId('ASO'), issueDate: day(5) }).expect(400); // emissão no futuro
    await enviar(company.id, employee.id, { typeId: typeId('ASO'), issueDate: day(-5), expiryDate: day(-10) }).expect(400);
    await enviar(company.id, employee.id, { typeId: 999999, issueDate: day(-5) }).expect(400);
    await enviar(company.id, employee.id, { typeId: typeId('RG e CPF') }, undefined, { content: Buffer.from('MZ'), name: 'virus.exe', type: 'application/x-msdownload' }).expect(400);
    await api().post(`/hr-documents/employee/${employee.id}`).set(auth(company.id)).field('typeId', String(typeId('RG e CPF'))).expect(400); // sem arquivo
    await enviar(company.id, employee.id, { typeId: typeId('RG e CPF') }, VIEW).expect(403);
    // documento sem validade entra sem data; imagem também vale
    const ok = await enviar(company.id, employee.id, { typeId: typeId('RG e CPF') }, undefined, { content: Buffer.from('imagem'), name: 'rg.jpg', type: 'image/jpeg' }).expect(201);
    const doc = pasta(ok.body, 'pessoais').documents[0];
    expect(doc.status).toBe('sem_validade');
    // quem não tem a permissão de documentos não vê nem baixa
    await api().get(`/hr-documents/employee/${employee.id}`).set(auth(company.id, ['list_funcionarios', 'view_funcionarios'])).expect(403);
    await api().get(`/hr-documents/${doc.id}/file`).set(auth(company.id, ['list_funcionarios', 'view_funcionarios'])).expect(403);
    // outra empresa não alcança
    const other = await makeCompany();
    await api().get(`/hr-documents/employee/${employee.id}`).set(auth(other.id)).expect(404);
    await api().get(`/hr-documents/${doc.id}/file`).set(auth(other.id)).expect(404);
    // corrigir o vencimento
    const fixed = await api().put(`/hr-documents/${doc.id}`).set(auth(company.id)).send({ expiryDate: day(10) }).expect(200);
    expect(pasta(fixed.body, 'pessoais').documents[0]).toMatchObject({ status: 'a_vencer', expiryDate: day(10) });
  });

  it('lista vencidos, a vencer e obrigatórios faltando; desligado e inativo ficam de fora', async () => {
    const { company, employee, typeId, alpinista } = await cenario();
    const ana = (await api().post('/employees').set(auth(company.id)).send({ name: 'Ana Souza' }).expect(201)).body;
    const saiu = (await api().post('/employees').set(auth(company.id)).send({ name: 'Bruno Saiu' }).expect(201)).body;
    await api().post(`/employees/${saiu.id}/events`).set(auth(company.id, [...RH, 'update_ocorrencias_funcionarios'])).send({ type: 'desligamento', startDate: day(-1), reason: 'Pedido' }).expect(201);
    // obrigatório só para alpinista
    await api().post('/hr-documents/types').set(auth(company.id)).send({ name: 'Certificado de alpinismo', folder: 'treinamentos', required: true, requiredProfessionalIds: [alpinista.id] }).expect(201);

    await enviar(company.id, employee.id, { typeId: typeId('NR-35'), issueDate: day(-800) }).expect(201); // vencido
    await enviar(company.id, ana.id, { typeId: typeId('ASO'), issueDate: day(-350) }).expect(201); // vence em ~15 dias
    await enviar(company.id, ana.id, { typeId: typeId('NR-33'), issueDate: day(-10) }).expect(201); // em dia: não aparece

    const res = await api().get('/hr-documents/expiring').set(auth(company.id, VIEW)).expect(200);
    expect(res.body.summary).toEqual({ vencido: 1, a_vencer: 1, faltando: 2 });
    const of = (status: string) => res.body.rows.filter((row: any) => row.status === status).map((row: any) => `${row.employee.name}: ${row.typeName}`).sort();
    expect(of('vencido')).toEqual(['José da Silva: NR-35']);
    expect(of('a_vencer')).toEqual(['Ana Souza: ASO']);
    expect(of('faltando')).toEqual(['José da Silva: ASO', 'José da Silva: Certificado de alpinismo']);
    expect(JSON.stringify(res.body.rows)).not.toContain('Bruno');
    expect((await api().get('/hr-documents/expiring?status=vencido').set(auth(company.id)).expect(200)).body.total).toBe(1);
    expect((await api().get('/hr-documents/expiring?search=ana').set(auth(company.id)).expect(200)).body.total).toBe(1);

    // a lista de funcionários leva o sinal de documentos só para quem pode ver documentos
    const list = await api().get('/employees').set(auth(company.id)).expect(200);
    const signal = Object.fromEntries(list.body.rows.map((row: any) => [row.name, row.documents]));
    expect(signal).toEqual({ 'Ana Souza': 'a_vencer', 'José da Silva': 'vencido' });
    const plain = await api().get('/employees').set(auth(company.id, ['list_funcionarios'])).expect(200);
    expect(plain.body.rows.every((row: any) => row.documents === null)).toBe(true);

    // Minha esteira: três blocos de RH para quem vê documentos; nenhum para quem não vê
    const mine = await api().get('/my-pipeline').set(auth(company.id, VIEW)).expect(200);
    const blocks = Object.fromEntries(mine.body.blocks.filter((block: any) => block.area === 'RH').map((block: any) => [block.key, block.count]));
    expect(blocks).toEqual({ docs_vencidos: 1, docs_vencer: 1, docs_faltando: 2 });
    const none = await api().get('/my-pipeline').set(auth(company.id, ['list_funcionarios'])).expect(200);
    expect(none.body.blocks.some((block: any) => block.area === 'RH')).toBe(false);
  });
  it('documentos da equipe da obra: tabela por pessoa e o pacote em ZIP com folha de rosto', async () => {
    const { company, employee, typeId, db } = await cenario();
    const OS = ['list_ordens_de_servico', 'view_ordens_de_servico', 'all_ordens_de_servico'];
    const ana = (await api().post('/employees').set(auth(company.id)).send({ name: 'Ana Souza', cpf: '529.982.247-25' }).set(auth(company.id, [...RH, 'view_dados_pessoais_funcionarios'])).expect(201)).body;
    const order = await db.service_Order.create({ data: {
      companyId: company.id, number: 'OS-2026-0001', year: 2026, sequence: 1, contractId: 9001, proposalId: 9001, customerId: 9001, title: 'Montagem', status: 'agendada', scope: [], checklist: [],
      plannedStart: new Date(`${day(5)}T00:00:00.000Z`), plannedEnd: new Date(`${day(40)}T00:00:00.000Z`),
      team: [{ name: 'José da Silva', role: 'Alpinista N2', employeeId: employee.id }, { name: 'Ana Souza', role: 'Soldador', employeeId: ana.id }, { name: 'Diarista', role: 'Ajudante' }],
    } });
    await enviar(company.id, employee.id, { typeId: typeId('ASO'), issueDate: day(-10) }).expect(201); // em dia
    await enviar(company.id, employee.id, { typeId: typeId('NR-35'), issueDate: day(-720) }).expect(201); // vence em ~10 dias: antes do fim da obra
    await enviar(company.id, ana.id, { typeId: typeId('NR-33'), issueDate: day(-400) }, undefined, { content: Buffer.from('nr33'), name: 'nr 33: ana.pdf', type: 'application/pdf' }).expect(201); // vencido

    const matrix = (await api().get(`/service-orders/${order.id}/team-documents`).set(auth(company.id, [...OS, ...VIEW])).expect(200)).body;
    expect(matrix.until).toBe(day(40));
    expect(matrix.outside).toEqual(['Diarista']);
    expect(matrix.rows.map((row: any) => [row.name, row.role])).toEqual([['Ana Souza', 'Soldador'], ['José da Silva', 'Alpinista N2']]);
    const cell = (name: string, type: string) => matrix.rows.find((row: any) => row.name === name).cells.find((item: any) => item.typeId === typeId(type)).status;
    expect(cell('José da Silva', 'ASO')).toBe('em_dia');
    expect(cell('José da Silva', 'NR-35')).toBe('vence_antes');
    expect(cell('Ana Souza', 'NR-33')).toBe('vencido');
    expect(cell('Ana Souza', 'ASO')).toBe('faltando'); // obrigatório
    expect(cell('Ana Souza', 'NR-35')).toBe('nao_enviado'); // não é obrigatório
    expect(matrix.summary).toEqual({ vencido: 1, faltando: 1, vence_antes: 1, a_vencer: 0 });
    // sem a permissão de documentos, quem só vê a OS não vê a tabela
    await api().get(`/service-orders/${order.id}/team-documents`).set(auth(company.id, OS)).expect(403);

    const zip = await api().post(`/service-orders/${order.id}/team-documents/package`).set(auth(company.id, [...OS, ...VIEW]))
      .send({ typeIds: [typeId('ASO'), typeId('NR-35'), typeId('NR-33')] }).buffer(true)
      .parse((res, done) => { const chunks: Buffer[] = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks))); }).expect(200);
    expect(zip.headers['content-type']).toContain('application/zip');
    const files = unzip(zip.body as Buffer);
    expect(Object.keys(files).sort()).toEqual(['Ana Souza/NR-33.pdf', 'Folha de rosto.csv', 'José da Silva/ASO.pdf', 'José da Silva/NR-35.pdf']);
    expect(files['José da Silva/ASO.pdf'].equals(PDF)).toBe(true);
    expect(files['Ana Souza/NR-33.pdf'].toString()).toBe('nr33');
    const sheet = files['Folha de rosto.csv'].toString('utf8');
    expect(sheet.split('\r\n')[0]).toBe('\uFEFF"Nome";"Função";"ASO";"NR-33";"NR-35"');
    expect(sheet).toContain('"Ana Souza";"Soldador";"não enviado";"VENCIDO em');
    expect(sheet).toContain('(vence antes do fim da obra)');
    expect(sheet).not.toContain('529'); // sem a permissão de dados pessoais, o CPF não vai
    // com a permissão, CPF e RG entram na folha
    const personal = await api().post(`/service-orders/${order.id}/team-documents/package`).set(auth(company.id, [...OS, ...VIEW, 'view_dados_pessoais_funcionarios']))
      .send({ typeIds: [typeId('ASO')], employeeIds: [ana.id] }).buffer(true)
      .parse((res, done) => { const chunks: Buffer[] = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks))); }).expect(200);
    const only = unzip(personal.body as Buffer);
    expect(Object.keys(only)).toEqual(['Folha de rosto.csv']);
    expect(only['Folha de rosto.csv'].toString('utf8')).toContain('"Ana Souza";"529.982.247-25"');
    // cada pacote gerado fica registrado
    expect(await db.flow_Event.count({ where: { entity: 'hr_package', entityId: order.id, type: 'pacote_documentos' } })).toBe(2);
    await api().post(`/service-orders/${order.id}/team-documents/package`).set(auth(company.id, [...OS, ...VIEW])).send({ typeIds: [] }).expect(400);
    await api().post(`/service-orders/${order.id}/team-documents/package`).set(auth(company.id, OS)).send({ typeIds: [typeId('ASO')] }).expect(403);
  });
});
