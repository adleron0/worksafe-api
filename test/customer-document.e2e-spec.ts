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
  const PERMS = ['list_clientes', 'create_clientes', 'update_clientes'];
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
});
