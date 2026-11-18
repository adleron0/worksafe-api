import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Comissão do vendedor na proposta. Ordem de prioridade do valor inicial (ao
 * criar a proposta ou trocar o vendedor): a comissão própria do vendedor; senão
 * o padrão da base de cálculo, se a diretoria o ligou; senão zero. Quem vê
 * custos pode mudar à mão na proposta.
 */
describe('Comercial — comissão padrão (e2e)', () => {
  const BASE = ['list_comercial', 'create_comercial', 'update_comercial', 'inactive_comercial', 'activate_comercial'];
  const MANAGER = [...BASE, 'view_custos_comercial'];
  const ALL = [...MANAGER, 'update_base_calculo'];
  let jwt: JwtService;
  let userId = 0;
  let cnpj = 0;

  beforeAll(async () => {
    blockRealNetwork();
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  beforeEach(async () => { await resetDb(); await flushCache(); resetAsaasMock(); });

  const auth = (companyId: number, permissions: string[] = ALL) => ({
    Authorization: `Bearer ${jwt.sign(
      { data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
    )}`,
  });
  const api = () => request(httpServer());

  async function makeCustomer(companyId: number) {
    const db = testDb();
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId } });
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = (await db.dOM_Cities.findFirst()) ?? (await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } }));
    return db.customer.create({ data: {
      name: 'Indústria Alfa', corporateName: 'Indústria Alfa SA', cnpj: String(11222333000100 + ++cnpj), companyId,
      rankId: rank.id, phone: '8133334444', email: 'compras@alfa.local', stateId: state.id, cityId: city.id,
    } });
  }

  async function cenario() {
    const company = await makeCompany();
    userId = (await makeSeller(company.id, { name: 'Quem cria' })).id;
    const ana = await makeSeller(company.id, { name: 'Ana' });
    const bruno = await makeSeller(company.id, { name: 'Bruno' });
    const customer = await makeCustomer(company.id);
    // a primeira leitura cria a base da planilha
    await api().get('/commercial/proposals/options').set(auth(company.id)).expect(200);
    // carteira (o PUT da comissão do vendedor exige vendedor marcado)
    for (const id of [userId, ana.id, bruno.id]) await api().post(`/commercial/sellers/${id}`).set(auth(company.id)).expect(201);
    return { company, customer, ana, bruno };
  }

  const criar = async (companyId: number, body: Record<string, unknown>, headers = auth(companyId)) =>
    (await api().post('/commercial/proposals').set(headers).send({ kind: 'servico', title: 'Pintura de tanque', ...body }).expect(201)).body;
  const stored = async (id: number) => {
    const row = await testDb().commercial_Proposal.findUniqueOrThrow({ where: { id } });
    return { rate: Number(row.commissionRate), base: row.commissionBase, inPrice: row.commissionInPrice };
  };

  async function ligarPadrao(companyId: number, commission: Record<string, unknown>) {
    const base = (await api().get('/commercial/cost-bases/current').set(auth(companyId)).expect(200)).body;
    const { body } = await api().put(`/commercial/cost-bases/${base.id}`).set(auth(companyId))
      .send({ defaults: { ...base.defaults, commission } }).expect(200);
    return body;
  }

  it('regra 1 — sem padrão ligado e sem comissão do vendedor, proposta nova nasce com comissão zero', async () => {
    const { company, customer } = await cenario();
    // as versões da base nascem com o padrão desligado
    const base = (await api().get('/commercial/cost-bases/current').set(auth(company.id)).expect(200)).body;
    expect(base.defaults.commission).toMatchObject({ enabled: false });
    const options = (await api().get('/commercial/proposals/options').set(auth(company.id)).expect(200)).body;
    expect(options.defaults.commission).toEqual({ rate: 0, base: 'lucro', inPrice: false, source: 'zero' });

    const proposal = await criar(company.id, { customerId: customer.id });
    expect(proposal.draft).toMatchObject({ commissionRate: 0, commissionBase: 'lucro', commissionInPrice: false });
    expect(await stored(proposal.id)).toEqual({ rate: 0, base: 'lucro', inPrice: false });
    // quem não vê custos também cria com zero
    const blind = await criar(company.id, { customerId: customer.id }, auth(company.id, BASE));
    expect(await stored(blind.id)).toMatchObject({ rate: 0 });
  });

  it('regra 2 — padrão da base ligado pela diretoria vira o valor inicial; desligado volta a zero', async () => {
    const { company, customer } = await cenario();
    // só quem tem a permissão da base de cálculo liga o padrão
    const current = (await api().get('/commercial/cost-bases/current').set(auth(company.id)).expect(200)).body;
    await api().put(`/commercial/cost-bases/${current.id}`).set(auth(company.id, MANAGER))
      .send({ defaults: { ...current.defaults, commission: { enabled: true, rate: 0.03, base: 'faturado' } } }).expect(403);

    const base = await ligarPadrao(company.id, { enabled: true, rate: 0.03, base: 'faturado', inPrice: true });
    expect(base.defaults.commission).toEqual({ enabled: true, rate: 0.03, base: 'faturado', inPrice: true });
    const options = (await api().get('/commercial/proposals/options').set(auth(company.id)).expect(200)).body;
    expect(options.defaults.commission).toEqual({ rate: 0.03, base: 'faturado', inPrice: true, source: 'padrao' });

    const proposal = await criar(company.id, { customerId: customer.id });
    expect(await stored(proposal.id)).toEqual({ rate: 0.03, base: 'faturado', inPrice: true });
    // quem não vê custos não muda, mas recebe o padrão
    const blind = await criar(company.id, { customerId: customer.id, commission: { rate: 0.4, base: 'lucro' } }, auth(company.id, BASE));
    expect(await stored(blind.id)).toEqual({ rate: 0.03, base: 'faturado', inPrice: true });
    // na proposta dá para editar à mão
    const manual = await criar(company.id, { customerId: customer.id, commission: { rate: 0.01, base: 'lucro', inPrice: false } });
    expect(await stored(manual.id)).toEqual({ rate: 0.01, base: 'lucro', inPrice: false });

    await ligarPadrao(company.id, { enabled: false, rate: 0.03, base: 'faturado' });
    expect(await stored((await criar(company.id, { customerId: customer.id })).id)).toMatchObject({ rate: 0 });
  });

  it('regra 3 — comissão do vendedor vence o padrão; trocar o vendedor troca a comissão; edição à mão fica', async () => {
    const { company, customer, ana, bruno } = await cenario();
    await ligarPadrao(company.id, { enabled: true, rate: 0.03, base: 'faturado' });

    // só a diretoria define a comissão do vendedor
    await api().put(`/commercial/sellers/${ana.id}/commission`).set(auth(company.id, MANAGER)).send({ rate: 0.05, base: 'lucro' }).expect(403);
    await api().put(`/commercial/sellers/${ana.id}/commission`).set(auth(company.id)).send({ rate: 0.9, base: 'lucro' }).expect(400);
    await api().put(`/commercial/sellers/${ana.id}/commission`).set(auth(company.id)).send({ rate: 0.05 }).expect(400);
    const detail = (await api().put(`/commercial/sellers/${ana.id}/commission`).set(auth(company.id)).send({ rate: 0.05, base: 'lucro' }).expect(200)).body;
    expect(detail.commission).toEqual({ rate: 0.05, base: 'lucro' });
    // pelo cadastro genérico de usuário não se muda a comissão
    await api().put(`/user/${bruno.id}`).set(auth(company.id, ['update_user'])).send({ commissionRate: 0.4 });
    expect((await testDb().user.findUniqueOrThrow({ where: { id: bruno.id } })).commissionRate).toBeNull();

    const options = (await api().get('/commercial/proposals/options').set(auth(company.id)).expect(200)).body;
    expect(options.sellers.find((s: any) => s.id === ana.id).commission).toEqual({ rate: 0.05, base: 'lucro', inPrice: false, source: 'vendedor' });
    expect(options.sellers.find((s: any) => s.id === bruno.id).commission).toBeNull();
    // quem não vê custos não recebe a comissão de ninguém
    const blindOptions = (await api().get('/commercial/proposals/options').set(auth(company.id, BASE)).expect(200)).body;
    expect(blindOptions.sellers.find((s: any) => s.id === ana.id).commission).toBeUndefined();

    // vendedor com comissão própria: vale a dele
    const proposal = await criar(company.id, { customerId: customer.id, sellerId: ana.id });
    expect(await stored(proposal.id)).toEqual({ rate: 0.05, base: 'lucro', inPrice: false });

    // troca para quem não tem comissão própria: vale o padrão da base
    const toBruno = (await api().put(`/commercial/proposals/${proposal.id}`).set(auth(company.id)).send({ ...proposal.draft, sellerId: bruno.id, commission: undefined }).expect(200)).body;
    expect(toBruno.draft.sellerId).toBe(bruno.id);
    expect(await stored(proposal.id)).toEqual({ rate: 0.03, base: 'faturado', inPrice: false });

    // de volta à Ana, por quem não vê custos (não manda comissão): a do vendedor
    await api().put(`/commercial/proposals/${proposal.id}`).set(auth(company.id, BASE)).send({ ...toBruno.draft, sellerId: ana.id }).expect(200);
    expect(await stored(proposal.id)).toMatchObject({ rate: 0.05, base: 'lucro' });

    // edição à mão com o mesmo vendedor fica como foi escrita
    const current = (await api().get(`/commercial/proposals/${proposal.id}`).set(auth(company.id)).expect(200)).body;
    await api().put(`/commercial/proposals/${proposal.id}`).set(auth(company.id)).send({ ...current.draft, commission: { rate: 0.07, base: 'faturado' } }).expect(200);
    expect(await stored(proposal.id)).toMatchObject({ rate: 0.07, base: 'faturado' });
    // salvar de novo sem mexer na comissão (mesmo vendedor) não a recalcula
    await api().put(`/commercial/proposals/${proposal.id}`).set(auth(company.id, BASE)).send({ ...current.draft, title: 'Outro título' }).expect(200);
    expect(await stored(proposal.id)).toMatchObject({ rate: 0.07, base: 'faturado' });

    // apagar a comissão da Ana: volta a valer o padrão da base
    const cleared = (await api().put(`/commercial/sellers/${ana.id}/commission`).set(auth(company.id)).send({ rate: null }).expect(200)).body;
    expect(cleared.commission).toBeNull();
    expect(await stored((await criar(company.id, { customerId: customer.id, sellerId: ana.id })).id)).toMatchObject({ rate: 0.03, base: 'faturado' });

    // sem vendedor informado, quem cria é o vendedor (e a comissão é a dele, se houver)
    await api().put(`/commercial/sellers/${userId}/commission`).set(auth(company.id)).send({ rate: 0.04, base: 'faturado' }).expect(200);
    const mine = await criar(company.id, { customerId: customer.id });
    expect(mine.draft.sellerId).toBe(userId);
    expect(await stored(mine.id)).toMatchObject({ rate: 0.04, base: 'faturado' });
  });
});
