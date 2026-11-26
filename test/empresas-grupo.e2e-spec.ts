import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as nock from 'nock';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { makeTestPfx } from 'src/features/fiscal/test-certificate';
import { packXml, SEFIN_URLS, unpackXml } from 'src/features/fiscal/sefin.client';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Empresas do grupo: vários CNPJs num sistema só. Cadastro, frente de cada CNPJ,
 * preenchimento automático pelo banco (origem ou frente), "distribuir", nota
 * fiscal emitida pelo CNPJ certo com a numeração dele e filtros do financeiro.
 */
process.env.FISCAL_SECRET = 'chave-fiscal-de-teste-com-32-chars!!';

describe('Empresas do grupo — vários CNPJs (e2e)', () => {
  const PERMS = ['config_empresas_grupo', 'view_nfse', 'emitir_nfse', 'config_fiscal', 'list_financeiro', 'create_financeiro', 'update_financeiro'];
  const SERVICOS = '12345678000195';
  const TREINAMENTOS = '11222333000181';
  const SEFIN = SEFIN_URLS.restrita;
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => { blockRealNetwork(); jwt = (await bootTestApp()).get(JwtService); });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); nock.cleanAll(); });
  beforeEach(async () => { await resetDb(); await flushCache(); nock.cleanAll(); });

  const auth = (companyId: number, permissions: string[] = PERMS) => ({
    Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}`,
  });
  const api = () => request(httpServer());

  async function cenario() {
    const db = testDb();
    const state = await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } });
    const city = await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } });
    const company = await makeCompany({ cnpj: SERVICOS, stateId: state.id, cityId: city.id, address: 'Rua da Aurora', addressNumber: '100', neighborhood: 'Boa Vista' });
    userId = (await makeSeller(company.id)).id;
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } });
    const customer = await db.customer.create({ data: {
      name: 'Alfa', corporateName: 'Indústria Alfa SA', cnpj: '33444555000172', companyId: company.id, rankId: rank.id,
      email: 'compras@alfa.local', stateId: state.id, cityId: city.id, street: 'Rua do Bom Jesus', number: 123, neighborhood: 'Recife Antigo', zipcode: '50030230',
    } });
    return { company, customer, state, city, h: auth(company.id) };
  }

  it('o cadastro da empresa vira o primeiro CNPJ; o segundo assume a frente e os registros novos nascem nele', async () => {
    const { company, state, city, h } = await cenario();
    const db = testDb();
    // registro de antes do segundo CNPJ
    const oldCourse = await db.course.create({ data: { name: 'NR-35 antigo', companyId: company.id, gradeTheory: '6', gradePracticle: '6' } });

    const first = (await api().get('/company-entities').set(h).expect(200)).body;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ cnpj: SERVICOS, isDefault: true });
    expect(first[0].kinds.sort()).toEqual(['locacao', 'servico', 'treinamento']);
    expect((await db.course.findUniqueOrThrow({ where: { id: oldCourse.id } })).entityId).toBe(first[0].id);

    await api().post('/company-entities').set(h).send({ cnpj: '11222333000180', corporateName: 'X', tradeName: 'X' }).expect(400); // dígito errado
    await api().post('/company-entities').set(auth(company.id, ['view_nfse'])).send({ cnpj: TREINAMENTOS, corporateName: 'X', tradeName: 'X' }).expect(403);
    const tr = (await api().post('/company-entities').set(h).send({
      cnpj: TREINAMENTOS, corporateName: 'WorkSafe Treinamentos Ltda', tradeName: 'WorkSafe Treinamentos', kinds: ['treinamento'], stateId: state.id, cityId: city.id,
    }).expect(201)).body;
    await api().post('/company-entities').set(h).send({ cnpj: TREINAMENTOS, corporateName: 'X', tradeName: 'X' }).expect(409);
    const list = (await api().get('/company-entities').set(h).expect(200)).body;
    expect(list.find((e: any) => e.id === first[0].id).kinds.sort()).toEqual(['locacao', 'servico']);

    // o banco preenche pela frente: curso → treinamentos; turma herda do curso; proposta de serviço → serviços
    const course = await db.course.create({ data: { name: 'NR-35', companyId: company.id, gradeTheory: '6', gradePracticle: '6' } });
    expect(course.entityId).toBe(tr.id);
    const klass = await db.courseClass.create({ data: { name: 'Turma 1', courseId: course.id, companyId: company.id } as never });
    expect(klass.entityId).toBe(tr.id);
    const bank = await db.financial_BankAccount.create({ data: { companyId: company.id, name: 'Itaú' } });
    expect(bank.entityId).toBe(first[0].id);

    // distribuir: o curso antigo vai para treinamentos (prévia só conta)
    const preview = (await api().post(`/company-entities/${tr.id}/assign`).set(h).send({ scope: 'treinamento', preview: true }).expect(200)).body;
    expect(preview.items.find((i: any) => i.key === 'courses').count).toBe(1);
    expect((await db.course.findUniqueOrThrow({ where: { id: oldCourse.id } })).entityId).toBe(first[0].id);
    await api().post(`/company-entities/${tr.id}/assign`).set(h).send({ scope: 'treinamento' }).expect(200);
    expect((await db.course.findUniqueOrThrow({ where: { id: oldCourse.id } })).entityId).toBe(tr.id);
    const usage = (await api().get(`/company-entities/${tr.id}/usage`).set(h).expect(200)).body;
    expect(usage.find((u: any) => u.key === 'courses').count).toBe(2);

    // o padrão não pode ser desativado
    await api().put(`/company-entities/${first[0].id}`).set(h).send({ active: false }).expect(400);
  });

  it('nota fiscal sai pelo CNPJ escolhido, com o certificado e a numeração dele', async () => {
    const { company, customer, state, city, h } = await cenario();
    const servicos = (await api().get('/company-entities').set(h).expect(200)).body[0];
    const tr = (await api().post('/company-entities').set(h).send({
      cnpj: TREINAMENTOS, corporateName: 'WorkSafe Treinamentos Ltda', tradeName: 'WorkSafe Treinamentos', kinds: ['treinamento'],
      stateId: state.id, cityId: city.id, address: 'Rua do Sol', addressNumber: '10', neighborhood: 'Santo Antônio',
    }).expect(201)).body;

    // cada CNPJ com a sua configuração
    for (const [entity, cnpj] of [[servicos.id, SERVICOS], [tr.id, TREINAMENTOS]] as const) {
      await api().put(`/fiscal/settings?entityId=${entity}`).set(h).send({ simplesNacional: 3, simplesRegime: 1, simplesTotalRate: 6, autoSendEmail: false }).expect(200);
      await api().post(`/fiscal/settings/certificate?entityId=${entity}`).set(h).field('password', 'teste123').attach('file', makeTestPfx(cnpj), 'c.pfx').expect(200);
    }
    // certificado de um CNPJ não entra no outro
    const wrong = await api().post(`/fiscal/settings/certificate?entityId=${tr.id}`).set(h).field('password', 'teste123').attach('file', makeTestPfx(SERVICOS), 'c.pfx').expect(400);
    expect(wrong.body.message).toMatch(/WorkSafe Treinamentos/);
    const service = (await api().post('/fiscal/service-codes').set(h).send({ name: 'Treinamento NR-35', nationalCode: '080201', issRate: 5, description: 'Treinamento para {cliente}.', isDefault: true }).expect(201)).body;
    const overview = (await api().get('/fiscal/settings/overview').set(h).expect(200)).body;
    expect(overview).toHaveLength(2);
    expect(overview.every((o: any) => o.ready)).toBe(true);

    const sent: string[] = [];
    const nfse = (key: string, n: string) => `<NFSe versao="1.01"><infNFSe Id="NFS${key}"><nNFSe>${n}</nNFSe><cStat>100</cStat><dhProc>2026-11-25T12:00:01-03:00</dhProc><valores><vLiq>1000.00</vLiq></valores><DPS/></infNFSe></NFSe>`;
    nock(SEFIN).post('/nfse', (b) => { sent.push(unpackXml(b.dpsXmlGZipB64)); return true; }).times(2)
      .reply(201, () => ({ chaveAcesso: `2611606${'1'.repeat(43)}`, nfseXmlGZipB64: packXml(nfse(`2611606${'1'.repeat(43)}`, String(sent.length))) }));
    const body = { takerKind: 'cliente', customerId: customer.id, serviceCodeId: service.id, grossValue: 1000, competence: new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10) };

    const preview = (await api().post('/fiscal/invoices/preview').set(h).send({ ...body, entityId: tr.id }).expect(200)).body;
    expect(preview.emitter).toMatchObject({ entityId: tr.id, cnpj: TREINAMENTOS });
    const a = (await api().post('/fiscal/invoices').set(h).send({ ...body, entityId: tr.id, emit: true }).expect(201)).body;
    const b = (await api().post('/fiscal/invoices').set(h).send({ ...body, emit: true }).expect(201)).body; // sem escolha: o padrão
    expect(a).toMatchObject({ status: 'autorizada', entityId: tr.id, dpsNumber: 1 });
    expect(b).toMatchObject({ status: 'autorizada', entityId: servicos.id, dpsNumber: 1 }); // numeração própria de cada CNPJ
    expect(sent[0]).toContain(`<CNPJ>${TREINAMENTOS}</CNPJ>`);
    expect(sent[1]).toContain(`<CNPJ>${SERVICOS}</CNPJ>`);

    const onlyTr = (await api().get(`/fiscal/invoices?entityId=${tr.id}`).set(h).expect(200)).body;
    expect(onlyTr.data.map((i: any) => i.id)).toEqual([a.id]);
    expect(onlyTr.data[0].entity.tradeName).toBe('WorkSafe Treinamentos');
    // a conta a receber da nota é do CNPJ que emitiu
    const rec = await testDb().financialRecords.findFirstOrThrow({ where: { companyId: company.id, fiscalInvoiceId: a.id } }).catch(() => null);
    if (rec) expect(rec.entityId).toBe(tr.id);
  });

  it('financeiro: conta a pagar com o CNPJ escolhido, filtros e conta de gateway por CNPJ', async () => {
    const { company, h } = await cenario();
    const servicos = (await api().get('/company-entities').set(h).expect(200)).body[0];
    const tr = (await api().post('/company-entities').set(h).send({ cnpj: TREINAMENTOS, corporateName: 'WorkSafe Treinamentos Ltda', tradeName: 'WorkSafe Treinamentos', kinds: ['treinamento'] }).expect(201)).body;
    const due = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    await api().post('/financial-payables').set(h).send({ description: 'Aluguel sala de aula', value: 900, dueDate: due, entityId: tr.id }).expect(201);
    await api().post('/financial-payables').set(h).send({ description: 'Combustível', value: 300, dueDate: due }).expect(201);
    await api().post('/financial-payables').set(h).send({ description: 'X', value: 1, dueDate: due, entityId: 999999 }).expect(400);

    const all = (await api().get('/financial/payables').set(h).expect(200)).body;
    const mine = (await api().get(`/financial/payables?entityId=${tr.id}`).set(h).expect(200)).body;
    const rows = (list: any) => (list.data ?? list.rows ?? []) as any[];
    expect(rows(all)).toHaveLength(2);
    expect(rows(mine).map((r) => r.description)).toEqual(['Aluguel sala de aula']);
    expect(rows(mine)[0].entity.tradeName).toBe('WorkSafe Treinamentos');
    const payables = await testDb().financial_Payable.findMany({ where: { companyId: company.id }, orderBy: { id: 'asc' } });
    expect(payables.map((p) => p.entityId)).toEqual([tr.id, servicos.id]);

    const dre = (await api().get(`/financial/reports/dre?entityId=${tr.id}`).set(h).expect(200)).body;
    expect(dre).toBeTruthy();

    // uma conta de gateway por provedor em cada CNPJ
    await api().post('/financial-bank-accounts').set(h).send({ name: 'Asaas Serviços', type: 'gateway', gateway: 'asaas' }).expect(201);
    await api().post('/financial-bank-accounts').set(h).send({ name: 'Asaas Treinamentos', type: 'gateway', gateway: 'asaas', entityId: tr.id }).expect(201);
    await api().post('/financial-bank-accounts').set(h).send({ name: 'Asaas Treinamentos 2', type: 'gateway', gateway: 'asaas', entityId: tr.id }).expect(409);
  });
  it('usuário limitado a um CNPJ só vê e grava registros dele; sem limite vê todos', async () => {
    const { company, h } = await cenario();
    const db = testDb();
    const servicos = (await api().get('/company-entities').set(h).expect(200)).body[0];
    const tr = (await api().post('/company-entities').set(h).send({ cnpj: TREINAMENTOS, corporateName: 'WorkSafe Treinamentos Ltda', tradeName: 'WorkSafe Treinamentos', kinds: ['treinamento'] }).expect(201)).body;
    const due = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    await api().post('/financial-payables').set(h).send({ description: 'Aluguel sala de aula', value: 900, dueDate: due, entityId: tr.id }).expect(201);
    await api().post('/financial-payables').set(h).send({ description: 'Combustível', value: 300, dueDate: due }).expect(201);
    const fuel = await db.financial_Payable.findFirstOrThrow({ where: { companyId: company.id, entityId: servicos.id } });

    // o administrador limita outro usuário a Treinamentos
    const admin = userId;
    const other = await makeSeller(company.id);
    const adminH = auth(company.id, [...PERMS, 'update_user', 'list_user']);
    await api().put(`/user/${other.id}`).set(adminH).send({ entityIds: [999999] }).expect(400);
    await api().put(`/user/${other.id}`).set(adminH).send({ entityIds: `${tr.id}` }).expect(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).entityIds).toEqual([tr.id]);

    userId = other.id;
    const limited = auth(company.id, [...PERMS, 'update_user']);
    const entities = (await api().get('/company-entities').set(limited).expect(200)).body;
    expect(entities.map((e: any) => e.id)).toEqual([tr.id]);
    const rows = (list: any) => (list.data ?? list.rows ?? []) as any[];
    const mine = (await api().get('/financial/payables').set(limited).expect(200)).body;
    expect(rows(mine).map((r) => r.description)).toEqual(['Aluguel sala de aula']);
    // pedir o outro CNPJ no filtro não fura a trava
    expect(rows((await api().get(`/financial/payables?entityId=${servicos.id}`).set(limited).expect(200)).body)).toHaveLength(0);
    // não grava no CNPJ que não vê
    await api().post('/financial-payables').set(limited).send({ description: 'X', value: 1, dueDate: due, entityId: servicos.id }).expect((r) => expect([400, 403]).toContain(r.status));
    expect(await db.financial_Payable.count({ where: { description: 'X' } })).toBe(0);
    await api().put(`/financial-payables/${fuel.id}`).set(limited).send({ description: 'mexido' }).expect((r) => expect([403, 404]).toContain(r.status));
    expect((await db.financial_Payable.findUniqueOrThrow({ where: { id: fuel.id } })).description).toBe('Combustível');
    // sem CNPJ informado, o registro nasce no CNPJ dele
    await api().post('/financial-payables').set(limited).send({ description: 'Apostilas', value: 50, dueDate: due }).expect(201);
    expect((await db.financial_Payable.findFirstOrThrow({ where: { description: 'Apostilas' } })).entityId).toBe(tr.id);
    // não dá a ninguém acesso a CNPJ que ele não vê (nem "todos")
    await api().put(`/user/${admin}`).set(limited).send({ entityIds: [servicos.id] }).expect(403);
    await api().put(`/user/${admin}`).set(limited).send({ entityIds: [] }).expect(403);

    // quem não tem limite segue vendo os dois
    userId = admin;
    expect(rows((await api().get('/financial/payables').set(h).expect(200)).body)).toHaveLength(3);
    expect((await api().get('/company-entities').set(h).expect(200)).body).toHaveLength(2);
  });
});
