import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Cliente aceita CNPJ (empresa) ou CPF (pessoa física): grava só dígitos,
 * confere os verificadores e não barra a edição de cadastro antigo com
 * documento inválido que não mudou.
 */
describe('Clientes — CPF ou CNPJ (e2e)', () => {
  const PERMS = ['list_clientes', 'create_clientes', 'update_clientes', 'inactive_clientes', 'activate_clientes', 'list_comercial'];
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => {
    blockRealNetwork();
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  beforeEach(async () => { await resetDb(); await flushCache(); resetAsaasMock(); });

  const auth = (companyId: number) => ({
    Authorization: `Bearer ${jwt.sign(
      { data: encryptPayload({ sub: userId, companyId, permissions: PERMS, profile: 'admin' }) },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
    )}`,
  });
  const api = () => request(httpServer());

  async function cenario() {
    const db = testDb();
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } });
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } });
    const base = { name: 'Fulano', corporateName: 'Fulano de Tal', email: 'f@x.local', phone: '81999998888', rankId: rank.id, stateId: state.id, cityId: city.id };
    return { db, company, base };
  }

  it('cadastra pessoa física com CPF (máscara vira dígitos)', async () => {
    const { company, base } = await cenario();
    const res = await api().post('/customer').set(auth(company.id)).send({ ...base, cnpj: '529.982.247-25' });
    expect(res.status).toBeLessThan(300);
    expect(res.body.cnpj ?? res.body.data?.cnpj).toBe('52998224725');
  });

  it('cadastra empresa com CNPJ válido', async () => {
    const { company, base } = await cenario();
    const res = await api().post('/customer').set(auth(company.id)).send({ ...base, cnpj: '33714458000161' });
    expect(res.status).toBeLessThan(300);
  });

  it('grava os dados fiscais (IE, IM, ICMS, ramo) pelo formulário multipart', async () => {
    const { db, company, base } = await cenario();
    const req = api().post('/customer').set(auth(company.id));
    const campos: Record<string, string> = {
      ...Object.fromEntries(Object.entries(base).map(([k, v]) => [k, String(v)])),
      cnpj: '33714458000161',
      stateRegistration: '0123456-78',
      municipalRegistration: '998877',
      icmsContributor: 'true',
      activityType: 'Industrial',
      cnae: '2063100 Fabricação de cosméticos',
      simplesNacional: 'true',
      phone2: '8133334444',
    };
    for (const [k, v] of Object.entries(campos)) req.field(k, v);
    const res = await req;
    expect(res.status).toBeLessThan(300);
    const row = await db.customer.findFirst({ where: { companyId: company.id, cnpj: '33714458000161' } });
    expect(row).toMatchObject({ stateRegistration: '0123456-78', municipalRegistration: '998877', icmsContributor: true, activityType: 'Industrial', cnae: '2063100 Fabricação de cosméticos', simplesNacional: true, phone2: '8133334444' });
    await api().put(`/customer/${row!.id}`).set(auth(company.id)).field('icmsContributor', 'false').field('stateRegistration', 'ISENTO').expect(200);
    expect(await db.customer.findUnique({ where: { id: row!.id } })).toMatchObject({ icmsContributor: false, stateRegistration: 'ISENTO' });
  });

  it('recusa CPF ou CNPJ com dígito errado e tamanho que não é nenhum dos dois', async () => {
    const { company, base } = await cenario();
    const cpf = await api().post('/customer').set(auth(company.id)).send({ ...base, cnpj: '52998224724' });
    expect(cpf.status).toBe(400);
    expect(JSON.stringify(cpf.body)).toContain('CPF inválido');
    const cnpj = await api().post('/customer').set(auth(company.id)).send({ ...base, cnpj: '33714458000162' });
    expect(cnpj.status).toBe(400);
    const curto = await api().post('/customer').set(auth(company.id)).send({ ...base, cnpj: '123456' });
    expect(curto.status).toBe(400);
  });

  it('edita cadastro antigo com CNPJ inválido sem mexer no documento', async () => {
    const { db, company, base } = await cenario();
    const old = await db.customer.create({ data: { ...base, cnpj: '44444444444444', companyId: company.id } });
    await api().put(`/customer/${old.id}`).set(auth(company.id)).send({ ...base, cnpj: '44444444444444', name: 'Heineken' }).expect(200);
    expect((await db.customer.findUnique({ where: { id: old.id } }))?.name).toBe('Heineken');
    // trocar para outro inválido não passa
    const res = await api().put(`/customer/${old.id}`).set(auth(company.id)).send({ ...base, cnpj: '55555555555555' });
    expect(res.status).toBe(400);
  });

  describe('contatos com papéis (comercial, financeiro, fiscal)', () => {
    async function clienteComBase() {
      const { db, company, base } = await cenario();
      const customer = await db.customer.create({ data: { ...base, cnpj: '33714458000161', companyId: company.id } });
      const novo = (body: Record<string, unknown>) =>
        api().post('/customer-contacts').set(auth(company.id))
          .send({ customerId: customer.id, email: 'c@x.local', phone: '81999990000', ...body }).expect(201).then((r) => r.body);
      const contatos = async () => db.customer_Contacts.findMany({ where: { customerId: customer.id }, orderBy: { id: 'asc' } });
      return { db, company, customer, novo, contatos };
    }

    it('primeiro contato do papel vira padrão; marcar outro como padrão tira do anterior', async () => {
      const { company, novo, contatos } = await clienteComBase();
      const ana = await novo({ name: 'Ana', isCommercial: true, isFinancial: true });
      const bia = await novo({ name: 'Bia', isCommercial: true });
      let rows = await contatos();
      expect(rows.find((r) => r.id === ana.id)).toMatchObject({ defaultCommercial: true, defaultFinancial: true, defaultFiscal: false });
      expect(rows.find((r) => r.id === bia.id)).toMatchObject({ defaultCommercial: false });

      await api().put(`/customer-contacts/${bia.id}`).set(auth(company.id)).send({ defaultCommercial: true }).expect(200);
      rows = await contatos();
      expect(rows.find((r) => r.id === bia.id)?.defaultCommercial).toBe(true);
      expect(rows.find((r) => r.id === ana.id)).toMatchObject({ defaultCommercial: false, defaultFinancial: true });
    });

    it('não é padrão sem o papel; inativar o padrão passa para outro', async () => {
      const { company, novo, contatos } = await clienteComBase();
      const ana = await novo({ name: 'Ana', isCommercial: true, defaultFiscal: true });
      const bia = await novo({ name: 'Bia', isCommercial: true });
      expect((await contatos()).find((r) => r.id === ana.id)).toMatchObject({ defaultCommercial: true, defaultFiscal: false });

      await api().patch(`/customer-contacts/inactive/${ana.id}`).set(auth(company.id)).expect(200);
      const rows = await contatos();
      expect(rows.find((r) => r.id === ana.id)?.defaultCommercial).toBe(false);
      expect(rows.find((r) => r.id === bia.id)?.defaultCommercial).toBe(true);
    });

    it('a proposta recebe os contatos com o comercial padrão primeiro', async () => {
      const { company, customer, novo } = await clienteComBase();
      await novo({ name: 'Aaron', isFinancial: true });
      await novo({ name: 'Zeca', isCommercial: true });
      const res = await api().get('/commercial/proposals/customers').set(auth(company.id)).expect(200);
      const row = res.body.find((c: any) => c.id === customer.id);
      expect(row.contacts.map((c: any) => c.name)).toEqual(['Zeca', 'Aaron']);
      expect(row.contacts[0]).toMatchObject({ isCommercial: true, defaultCommercial: true });
    });
  });
});
