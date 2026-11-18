import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Fluxo comercial — fases 1 e 5 do plano 08.
 *
 * Fase 1: o tipo da proposta (serviço, treinamento, locação) decide os itens
 * aceitos e o que nasce do aceite (OS, turma, ordem de locação).
 * Fase 5: turma fechada sempre com origem do dinheiro — ligada a uma venda,
 * feita por venda rápida ou marcada "sem cobrança" com motivo.
 */
describe('Comercial — tipos da proposta e turma fechada × venda (e2e)', () => {
  const COMMERCIAL = ['list_comercial', 'create_comercial', 'update_comercial', 'inactive_comercial', 'activate_comercial', 'view_custos_comercial'];
  const FINANCE = ['list_financeiro', 'create_financeiro', 'update_financeiro'];
  const ALL = [...COMMERCIAL, ...FINANCE, 'create_classes', 'view_treinamentos'];
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

  async function makeCustomer(companyId: number, name = 'Indústria Alfa') {
    const db = testDb();
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId } });
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = (await db.dOM_Cities.findFirst()) ?? (await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } }));
    return db.customer.create({ data: {
      name, corporateName: `${name} SA`, cnpj: String(11222333000100 + ++cnpj), companyId,
      rankId: rank.id, phone: '8133334444', email: 'compras@alfa.local', stateId: state.id, cityId: city.id,
    } });
  }

  async function base() {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const customer = await makeCustomer(company.id);
    return { company, customer, h: auth(company.id) };
  }
  const accept = async (h: Record<string, string>, id: number) => {
    await api().patch(`/commercial/proposals/status/${id}`).set(h).send({ status: 'enviada' }).expect(200);
    await api().patch(`/commercial/proposals/status/${id}`).set(h).send({ status: 'aceita' }).expect(200);
    return testDb().commercial_Contract.findUniqueOrThrow({ where: { proposalId: id } });
  };

  // ------------------------------------------------------------------ fase 1

  it('cada tipo nasce com as suas seções e recusa itens de outro tipo', async () => {
    const { customer, h } = await base();
    const rent = (await api().post('/commercial/proposals').set(h).send({ kind: 'locacao', customerId: customer.id, title: 'Locação de tripé' }).expect(201)).body;
    expect(rent.draft.kind).toBe('locacao');
    expect(rent.draft.sections.map((s: any) => s.kind)).toEqual(['locacao_cliente', 'avulso']);

    await api().post('/commercial/proposals').set(h).send({ kind: 'misto', customerId: customer.id, title: 'Antigo misto' }).expect(201)
      .then((r) => expect(r.body.draft.kind).toBe('servico'));

    const mixed = await api().post('/commercial/proposals').set(h).send({
      kind: 'servico', customerId: customer.id, title: 'Serviço com curso',
      sections: [{ title: 'Treinamentos', kind: 'treinamento', items: [{ type: 'treinamento', description: 'NR-35', finalValue: 1000 }] }],
    }).expect(400);
    expect(mixed.body.message).toMatch(/serviço não leva itens de treinamento/);

    // um item de outro tipo dentro de uma seção permitida também é recusado
    await api().post('/commercial/proposals').set(h).send({
      kind: 'treinamento', customerId: customer.id, title: 'Curso com mão de obra',
      sections: [{ title: 'Outros', kind: 'avulso', items: [{ type: 'locacao_cliente', description: 'Tripé', finalValue: 100 }] }],
    }).expect(400);
  });

  it('venda de locação não abre OS: abre a ordem de locação', async () => {
    const { company, customer, h } = await base();
    const tripe = await testDb().stock_Item.create({ data: { companyId: company.id, code: 'TRP', name: 'Tripé de resgate', tracking: 'quantidade', rentable: true } as any });
    const proposal = (await api().post('/commercial/proposals').set(h).send({
      kind: 'locacao', customerId: customer.id, title: 'Locação de tripé', contingencyRate: 0,
      sections: [{ title: 'Equipamentos', kind: 'locacao_cliente', margin: 0, items: [
        { type: 'locacao_cliente', description: 'Tripé', quantity: 1, stockItemId: tripe.id, extra: { period: 'mes', periods: 2, rate: 1500 } },
      ] }],
      installments: [{ percent: 1, dueRule: 'dias_apos_nf', dueDays: 10 }],
    }).expect(201)).body;
    const contract = await accept(h, proposal.id);
    expect(contract.kind).toBe('locacao');
    expect(await testDb().service_Order.count({ where: { contractId: contract.id } })).toBe(0);
    expect(await testDb().stock_Rental.findFirst({ where: { contractId: contract.id } })).toMatchObject({ status: 'reservada', customerId: customer.id });
    // abrir o quadro de OS não cria OS atrasada para a venda de locação
    await api().get('/service-orders').set(auth(company.id, [...ALL, 'list_ordens_de_servico', 'all_ordens_de_servico'])).expect(200);
    expect(await testDb().service_Order.count({ where: { contractId: contract.id } })).toBe(0);
  });

  // ------------------------------------------------------------------ fase 5

  it('venda rápida de turma fechada: proposta aceita + contrato, valor exato, turma ligada', async () => {
    const { company, customer, h } = await base();
    const course = await makeCourse(company.id);
    const klass = await makeCourseClass(company.id, course.id, { customerId: customer.id, allowCheckout: false, allowSubscriptions: false, name: 'NR-35 Alfa' });

    const sale = (await api().post('/commercial/quick-sale').set(h).send({
      classId: klass.id, value: 4200, installments: [{ percent: 0.5, dueRule: 'dias_apos_nf', dueDays: 0 }, { percent: 0.5, dueRule: 'dias_apos_nf', dueDays: 30 }],
    }).expect(201)).body;
    expect(sale.total).toBe(4200);
    const proposal = await testDb().commercial_Proposal.findUniqueOrThrow({ where: { id: sale.proposalId } });
    expect(proposal).toMatchObject({ kind: 'treinamento', status: 'aceita', customerId: customer.id, sellerId: userId });
    expect(Number(proposal.total)).toBe(4200);

    const contract = (await api().get(`/commercial/contracts/${sale.contractId}`).set(h).expect(200)).body;
    expect(contract).toMatchObject({ kind: 'treinamento', value: 4200, toBill: 4200 });
    expect(contract.installments.map((i: any) => i.value)).toEqual([2100, 2100]);
    expect(contract.classes[0].classIds).toEqual([klass.id]);
    expect(await testDb().service_Order.count()).toBe(0);

    const billing = (await api().get(`/commercial/classes/${klass.id}/billing`).set(h).expect(200)).body;
    expect(billing.billing).toMatchObject({ mode: 'contrato', contract: { id: sale.contractId } });
    // a mesma turma não ganha outra venda rápida
    await api().post('/commercial/quick-sale').set(h).send({ classId: klass.id, value: 100 }).expect(409);
  });

  it('turma fechada sem venda aparece no painel até ganhar venda ou "sem cobrança"', async () => {
    const { company, customer, h } = await base();
    const course = await makeCourse(company.id);
    const klass = await makeCourseClass(company.id, course.id, { customerId: customer.id, name: 'Turma interna' });
    await makeCourseClass(company.id, course.id, { name: 'Turma aberta' }); // sem cliente: cobra pelas inscrições

    const alerts = async () => (await api().get('/dashboard/training').set(h).expect(200)).body.actions.filter((a: any) => a.key.startsWith('nosale-'));
    expect((await alerts()).map((a: any) => a.key)).toEqual([`nosale-${klass.id}`]);
    expect((await api().get('/commercial/classes/unbilled').set(h).expect(200)).body.map((c: any) => c.id)).toEqual([klass.id]);

    await api().put(`/commercial/classes/${klass.id}/billing`).set(h).send({ mode: 'sem_cobranca', reason: '' }).expect(400);
    const exempt = (await api().put(`/commercial/classes/${klass.id}/billing`).set(h).send({ mode: 'sem_cobranca', reason: 'Treinamento da equipe' }).expect(200)).body;
    expect(exempt.billing).toMatchObject({ mode: 'sem_cobranca', reason: 'Treinamento da equipe', contract: null });
    expect(await alerts()).toEqual([]);

    // desfazer volta a avisar; quem só vê treinamentos não recebe o aviso
    await api().put(`/commercial/classes/${klass.id}/billing`).set(h).send({ mode: 'nenhum' }).expect(200);
    expect(await alerts()).toHaveLength(1);
    const plain = (await api().get('/dashboard/training').set(auth(company.id, ['view_treinamentos'])).expect(200)).body;
    expect(plain.actions.filter((a: any) => a.key.startsWith('nosale-'))).toEqual([]);
    // sem permissão do comercial não muda a origem do dinheiro
    await api().put(`/commercial/classes/${klass.id}/billing`).set(auth(company.id, ['list_comercial'])).send({ mode: 'sem_cobranca', reason: 'x' }).expect(403);
  });

  it('ligar turma a uma venda existente ocupa o item do curso; trocar de venda libera o item', async () => {
    const { company, customer, h } = await base();
    const course = await makeCourse(company.id);
    const training = (courseId: number) => ({
      kind: 'treinamento', customerId: customer.id, title: 'NR-35 in company', contingencyRate: 0,
      sections: [{ title: 'Treinamentos', kind: 'treinamento', margin: 0, items: [{ type: 'treinamento', courseId, quantity: 1, finalValue: 3000 }] }],
      installments: [{ percent: 1, dueRule: 'dias_apos_nf', dueDays: 30 }],
    });
    const first = await accept(h, (await api().post('/commercial/proposals').set(h).send(training(course.id)).expect(201)).body.id);
    const second = await accept(h, (await api().post('/commercial/proposals').set(h).send(training(course.id)).expect(201)).body.id);
    const klass = await makeCourseClass(company.id, course.id, { customerId: customer.id });

    const view = (await api().get(`/commercial/classes/${klass.id}/billing`).set(h).expect(200)).body;
    expect(view).toMatchObject({ closed: true, billing: null });
    expect(view.candidates.map((c: any) => [c.id, c.freeSlots])).toEqual(expect.arrayContaining([[first.id, 1], [second.id, 1]]));

    await api().put(`/commercial/classes/${klass.id}/billing`).set(h).send({ mode: 'contrato', contractId: first.id }).expect(200);
    let a = (await api().get(`/commercial/contracts/${first.id}`).set(h).expect(200)).body;
    expect(a.classes[0].classIds).toEqual([klass.id]);

    await api().put(`/commercial/classes/${klass.id}/billing`).set(h).send({ mode: 'contrato', contractId: second.id }).expect(200);
    a = (await api().get(`/commercial/contracts/${first.id}`).set(h).expect(200)).body;
    const b = (await api().get(`/commercial/contracts/${second.id}`).set(h).expect(200)).body;
    expect(a.classes[0].classIds).toEqual([]);
    expect(b.classes[0].classIds).toEqual([klass.id]);

    // venda de outro cliente não serve
    const other = await makeCustomer(company.id, 'Beta Ltda');
    const foreign = await accept(h, (await api().post('/commercial/proposals').set(h).send({ ...training(course.id), customerId: other.id }).expect(201)).body.id);
    await api().put(`/commercial/classes/${klass.id}/billing`).set(h).send({ mode: 'contrato', contractId: foreign.id }).expect(400);
  });

  it('turma criada pelo contrato já nasce ligada à venda', async () => {
    const { company, customer, h } = await base();
    const course = await makeCourse(company.id);
    const proposal = (await api().post('/commercial/proposals').set(h).send({
      kind: 'treinamento', customerId: customer.id, title: 'NR-35', contingencyRate: 0,
      sections: [{ title: 'Treinamentos', kind: 'treinamento', margin: 0, items: [{ type: 'treinamento', courseId: course.id, quantity: 1, finalValue: 2000 }] }],
      installments: [{ percent: 1, dueRule: 'dias_apos_nf', dueDays: 30 }],
    }).expect(201)).body;
    const contract = await accept(h, proposal.id);
    const created = (await api().post(`/commercial/contracts/${contract.id}/classes/0`).set(h).send({}).expect(201)).body;
    expect(await testDb().commercial_ClassBilling.findUnique({ where: { classId: created.classId } })).toMatchObject({ mode: 'contrato', contractId: contract.id });
    expect((await api().get('/commercial/classes/unbilled').set(h).expect(200)).body).toEqual([]);
  });
});
