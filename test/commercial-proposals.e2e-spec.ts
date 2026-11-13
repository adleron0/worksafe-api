import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import * as Zlib from 'zlib';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Comercial — propostas (serviço e treinamento na mesma proposta).
 *
 * O que não pode quebrar: o número da planilha (R$ 20.589,11) sai igual pela
 * proposta; o valor sugerido nunca é imposto; a proposta guarda a base usada;
 * e quem não tem a permissão de custos não vê nem muda margem.
 */
describe('Comercial — propostas (e2e)', () => {
  const BASE = ['list_comercial', 'create_comercial', 'update_comercial', 'inactive_comercial', 'activate_comercial'];
  const ALL = [...BASE, 'view_custos_comercial'];
  const YEAR = new Date().getFullYear();
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

  async function cenario() {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const customer = await makeCustomer(company.id);
    const options = (await api().get('/commercial/proposals/options').set(auth(company.id)).expect(200)).body;
    const pro = (name: string) => options.professionals.find((p: any) => p.name === name).id as number;
    return { company, customer, options, pro };
  }

  /** O exemplo preenchido da planilha, como proposta. */
  const exemplo = (customerId: number, professionalId: number, extra: Record<string, unknown> = {}) => ({
    kind: 'servico', customerId, title: 'Jateamento de estrutura', workDays: 22, contingencyRate: 0.05,
    commission: { rate: 0.02, base: 'faturado' },
    sections: [{ title: 'Mão de obra', kind: 'mao_de_obra', margin: 0.26, items: [{ type: 'mao_de_obra', professionalId, quantity: 1 }] }],
    ...extra,
  });
  const criar = async (companyId: number, body: Record<string, unknown>, headers = auth(companyId)) =>
    (await api().post('/commercial/proposals').set(headers).send(body).expect(201)).body;

  it('nasce como rascunho numerado, com as seções do tipo escolhido', async () => {
    const { company, customer } = await cenario();
    const servico = await criar(company.id, { kind: 'servico', customerId: customer.id, title: 'Pintura de tanque' });
    expect(servico).toMatchObject({ number: `PC-${YEAR}-0001`, status: 'rascunho', revision: 0, editable: true });
    expect(servico.draft.sections.map((s: any) => [s.title, s.margin])).toEqual([['Mão de obra', 0.26], ['Locações', 0.05], ['Materiais de consumo', 0]]);
    expect(servico.draft).toMatchObject({ contingencyRate: 0.05, commissionRate: 0.02, commissionBase: 'faturado' });
    const treino = await criar(company.id, { kind: 'treinamento', customerId: customer.id, title: 'NR-35 in company' });
    expect(treino.number).toBe(`PC-${YEAR}-0002`);
    expect(treino.draft.sections.map((s: any) => s.kind)).toEqual(['treinamento']);
    // numeração é por empresa
    const other = await makeCompany();
    const otherCustomer = await makeCustomer(other.id, 'Beta');
    expect((await criar(other.id, { customerId: otherCustomer.id, title: 'Outra empresa' })).number).toBe(`PC-${YEAR}-0001`);
  });

  it('o exemplo da planilha, feito como proposta, dá R$ 20.589,11', async () => {
    const { company, customer, pro } = await cenario();
    const proposal = await criar(company.id, exemplo(customer.id, pro('Alpinista N1')));
    expect(proposal.calc.totals).toMatchObject({ cost: 10392.6, suggested: 19608.68, total: 20589.11, tax: 4323.71, profit: 5872.8, commission: 411.78 });
    expect(proposal.calc.sections[0].lines[0]).toMatchObject({ cost: 10392.6, hourCost: 59.05, hours: 176, suggested: 19608.68, value: 19608.68 });
    expect(proposal.calc.margin).toMatchObject({ unused: 6179.58, minTotal: 12911.66 });
    expect(proposal.draft.sections[0].items[0].description).toBe('Alpinista N1');
    const row = await testDb().commercial_Proposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect([Number(row.total), Number(row.totalCost), Number(row.profit)]).toEqual([20589.11, 10392.6, 5872.8]);
    // a prévia (sem gravar) devolve o mesmo
    const preview = (await api().post('/commercial/proposals/preview').set(auth(company.id)).send(exemplo(customer.id, pro('Alpinista N1'))).expect(201)).body;
    expect(preview.totals.total).toBe(20589.11);
    expect(await testDb().commercial_Proposal.count()).toBe(1);
  });

  it('sugestão não é imposição: valor final, desconto e itens de outros tipos', async () => {
    const { company, customer, pro } = await cenario();
    const proposal = await criar(company.id, exemplo(customer.id, pro('Alpinista N1'), {
      contingencyRate: 0, discount: 500,
      sections: [
        { title: 'Mão de obra', kind: 'mao_de_obra', margin: 0.26, items: [{ type: 'mao_de_obra', professionalId: pro('Alpinista N1'), quantity: 1, finalValue: 18000 }] },
        { title: 'Locações', kind: 'locacao', margin: 0.05, items: [{ type: 'locacao', description: 'Andaime', unit: 'dia', quantity: 22, unitCost: 100, extraCost: 300 }] },
        { title: 'Extras', kind: 'avulso', margin: 0, items: [{ type: 'avulso', description: 'Mobilização', quantity: 1, unitCost: 0, finalValue: 1200 }] },
      ],
    }));
    const [labor, rental, extra] = proposal.calc.sections;
    expect(labor.lines[0]).toMatchObject({ suggested: 19608.68, value: 18000 });
    expect(labor.lines[0].margin).toBeCloseTo(1 - 0.21 - 10392.6 / 18000, 4);
    expect(rental.lines[0]).toMatchObject({ cost: 2500, suggested: 3378.38, value: 3378.38 });
    expect(extra.lines[0]).toMatchObject({ cost: 0, suggested: 0, value: 1200 });
    expect(proposal.calc.totals).toMatchObject({ subtotal: 22578.38, discount: 500, total: 22078.38 });
  });

  it('quem não tem a permissão de custos não vê nem muda margem, mas monta a proposta', async () => {
    const { company, customer, pro } = await cenario();
    const seller = auth(company.id, BASE);
    const options = (await api().get('/commercial/proposals/options').set(seller).expect(200)).body;
    expect(options.canSeeCosts).toBe(false);
    expect(options.professionals[0].hourCost).toBeUndefined();
    expect(options.defaults.margins).toBeUndefined();

    // tenta impor margem 90% e comissão 40%: ficam os padrões da base
    const created = await criar(company.id, exemplo(customer.id, pro('Alpinista N1'), {
      commission: { rate: 0.4, base: 'lucro' },
      sections: [{ title: 'Mão de obra', kind: 'mao_de_obra', margin: 0.9, items: [{ type: 'mao_de_obra', professionalId: pro('Alpinista N1'), quantity: 1, margin: 0.9 }] }],
    }), seller);
    expect(created.calc.totals.total).toBe(20589.11);
    expect(created.calc.totals.cost).toBeUndefined();
    expect(created.calc.totals.profit).toBeUndefined();
    expect(created.calc.margin).toBeUndefined();
    expect(created.calc.sections[0].lines[0]).toEqual({ suggested: 19608.68, value: 19608.68, hours: 176, listPrice: null });
    expect(created.draft.sections[0].margin).toBeUndefined();
    expect(created.draft.commissionRate).toBeUndefined();
    expect(JSON.stringify(created)).not.toContain('salar');

    // edita o valor final; a margem gravada continua a do gestor
    const section = created.draft.sections[0];
    const updated = (await api().put(`/commercial/proposals/${created.id}`).set(seller).send({
      ...created.draft, sections: [{ ...section, margin: 0.01, items: [{ ...section.items[0], finalValue: 21000 }] }],
    }).expect(200)).body;
    expect(updated.calc.totals.total).toBe(22050);
    const stored = await testDb().commercial_ProposalSection.findFirstOrThrow({ where: { proposalId: created.id } });
    expect(Number(stored.margin)).toBe(0.26);
    expect(Number((await testDb().commercial_Proposal.findUniqueOrThrow({ where: { id: created.id } })).commissionRate)).toBe(0.02);

    // o gestor vê tudo na mesma proposta
    const manager = (await api().get(`/commercial/proposals/${created.id}`).set(auth(company.id)).expect(200)).body;
    expect(manager.calc.totals.cost).toBe(10392.6);
    expect(manager.draft.sections[0].margin).toBe(0.26);
  });

  it('token de verdade: as permissões chegam compactadas, e a de custos vale do mesmo jeito', async () => {
    const { company, customer, pro } = await cenario();
    // mesmo formato que o login grava no token
    const packed = (permissions: string[]) => ({
      Authorization: `Bearer ${jwt.sign(
        { data: encryptPayload({ sub: userId, companyId: company.id, profile: 'admin', permissions: Zlib.deflateRawSync(JSON.stringify(permissions), { level: 9 }).toString('base64') }) },
        { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
      )}`,
    });
    const manager = await criar(company.id, exemplo(customer.id, pro('Alpinista N1')), packed(ALL));
    expect(manager.canSeeCosts).toBe(true);
    expect(manager.calc.totals.cost).toBe(10392.6);
    const seller = (await api().get(`/commercial/proposals/${manager.id}`).set(packed(BASE)).expect(200)).body;
    expect(seller.canSeeCosts).toBe(false);
    expect(seller.calc.totals.cost).toBeUndefined();
    expect((await api().get('/commercial/proposals/options').set(packed(ALL)).expect(200)).body.professionals[0].hourCost).toBeGreaterThan(0);
  });

  it('a proposta guarda a base usada: mudar a configuração depois não muda o preço, até pedir para recalcular', async () => {
    const { company, customer, pro } = await cenario();
    const proposal = await criar(company.id, exemplo(customer.id, pro('Alpinista N1')));
    expect(proposal.baseOutdated).toBe(false);

    const base = (await api().get('/commercial/cost-bases/current').set(auth(company.id))).body;
    await api().put(`/commercial/cost-bases/${base.id}`).set(auth(company.id)).send({ params: { ...base.params, headcount: 12 } }).expect(200);
    await testDb().commercial_Professional.updateMany({ where: { name: 'Alpinista N1' }, data: { salary: 9999 } });

    const after = (await api().get(`/commercial/proposals/${proposal.id}`).set(auth(company.id)).expect(200)).body;
    expect(after.calc.totals.total).toBe(20589.11);
    expect(after.baseOutdated).toBe(true);

    // salvar sem pedir recálculo mantém a fotografia
    const saved = (await api().put(`/commercial/proposals/${proposal.id}`).set(auth(company.id)).send(after.draft).expect(200)).body;
    expect(saved.calc.totals.total).toBe(20589.11);

    const refreshed = (await api().put(`/commercial/proposals/${proposal.id}`).set(auth(company.id)).send({ ...after.draft, refreshBase: true }).expect(200)).body;
    expect(refreshed.baseOutdated).toBe(false);
    expect(refreshed.calc.totals.total).toBeGreaterThan(20589.11);
    expect(refreshed.calc.sections[0].lines[0].hourCost).toBeGreaterThan(72.2);
  });

  it('com mais de uma base de cálculo, dá para escolher qual a proposta usa', async () => {
    const { company, customer, pro } = await cenario();
    const h = auth(company.id);
    const current = (await api().get('/commercial/cost-bases/current').set(h).expect(200)).body;
    // uma segunda base, que só valeria sozinha em 2099
    const other = (await api().post('/commercial/cost-bases').set(h)
      .send({ name: 'Base enxuta (12 pessoas)', effectiveFrom: '2099-01-01', params: { ...current.params, headcount: 12 } }).expect(201)).body;
    const options = (await api().get('/commercial/proposals/options').set(h).expect(200)).body;
    expect(options.costBases.map((b: any) => [b.name, b.current])).toEqual([['Base enxuta (12 pessoas)', false], ['Base da planilha FORM-COM-001', true]]);
    expect((await api().get('/commercial/proposals/options').set(auth(company.id, BASE)).expect(200)).body.costBases).toEqual([]);

    // sem escolher, vale a vigente na data
    const proposal = await criar(company.id, exemplo(customer.id, pro('Alpinista N1')));
    expect(proposal.draft.costBaseId).toBeNull();
    expect(proposal.calc).toMatchObject({ costBase: 'Base da planilha FORM-COM-001', totals: { total: 20589.11 } });

    const put = (body: Record<string, unknown>, headers = h) => api().put(`/commercial/proposals/${proposal.id}`).set(headers).send({ ...proposal.draft, ...body });
    const chosen = (await put({ costBaseId: other.id }).expect(200)).body;
    expect(chosen.draft.costBaseId).toBe(other.id);
    expect(chosen.calc.costBase).toBe('Base enxuta (12 pessoas)');
    expect(chosen.calc.sections[0].lines[0].hourCost).toBe(72.2);
    expect(chosen.baseOutdated).toBe(false);
    // a prévia já mostra o efeito antes de salvar
    const preview = (await api().post('/commercial/proposals/preview').set(h).send({ ...chosen.draft, id: proposal.id, costBaseId: null }).expect(201)).body;
    expect(preview.totals.total).toBe(20589.11);

    // quem não vê custos não troca a base
    const seller = (await put({ costBaseId: null }, auth(company.id, BASE)).expect(200)).body;
    expect((await testDb().commercial_Proposal.findUniqueOrThrow({ where: { id: proposal.id } })).costBaseId).toBe(other.id);
    expect(seller.calc.totals.total).toBe(chosen.calc.totals.total);

    // base inativa ou de outra empresa não entra; voltar para a automática funciona
    await api().patch(`/commercial/cost-bases/inactive/${other.id}`).set(h).expect(200);
    await put({ costBaseId: other.id, refreshBase: true }).expect(400);
    const foreign = await makeCompany();
    const foreignBase = (await api().get('/commercial/cost-bases/current').set(auth(foreign.id)).expect(200)).body;
    await put({ costBaseId: foreignBase.id }).expect(400);
    const back = (await put({ costBaseId: null }).expect(200)).body;
    expect(back.calc).toMatchObject({ costBase: 'Base da planilha FORM-COM-001', totals: { total: 20589.11 } });
  });

  it('trocar o regime na proposta recalcula com o perfil híbrido', async () => {
    const { company, customer, pro } = await cenario();
    const proposal = await criar(company.id, exemplo(customer.id, pro('Alpinista N1')));
    const hybrid = (await api().put(`/commercial/proposals/${proposal.id}`).set(auth(company.id)).send({ ...proposal.draft, taxRegime: 'hibrido' }).expect(200)).body;
    expect(hybrid.calc.tax).toMatchObject({ regime: 'hibrido', outside: 0.091 });
    expect(hybrid.calc.totals.taxOutside).toBeGreaterThan(0);
    expect(hybrid.calc.totals.total).not.toBe(20589.11);
    const back = (await api().put(`/commercial/proposals/${proposal.id}`).set(auth(company.id)).send({ ...hybrid.draft, taxRegime: null }).expect(200)).body;
    expect(back.calc.totals.total).toBe(20589.11);
  });

  it('treinamento: valor sugerido vem da tabela in-company do curso', async () => {
    const { company, customer } = await cenario();
    const course = await makeCourse(company.id);
    const other = await makeCourse(company.id, { name: 'NR-33 Espaço Confinado' });
    const price = (await api().put(`/commercial/course-prices/${course.id}`).set(auth(company.id))
      .send({ classPrice: 4500, includedStudents: 10, studentPrice: 300 }).expect(200)).body;
    expect(price).toMatchObject({ courseId: course.id, classPrice: 4500, includedStudents: 10, studentPrice: 300 });
    expect((await api().get('/commercial/course-prices').set(auth(company.id)).expect(200)).body).toHaveLength(2);

    const proposal = await criar(company.id, {
      kind: 'treinamento', customerId: customer.id, title: 'Treinamentos 2027', contingencyRate: 0,
      sections: [{ title: 'Treinamentos', kind: 'treinamento', margin: 0, items: [
        { type: 'treinamento', courseId: course.id, quantity: 1, unitCost: 1200, extra: { students: 14, workload: 8, dates: '10 e 11/02', location: 'Planta do cliente' } },
        { type: 'treinamento', courseId: course.id, quantity: 2, extra: { students: 15 } },
        { type: 'treinamento', courseId: other.id, quantity: 1, extra: { students: 8 }, finalValue: 3000 },
      ] }],
    });
    const [a, b, c] = proposal.calc.sections[0].lines;
    expect(a).toMatchObject({ listPrice: 5700, suggested: 5700, value: 5700, cost: 1200 }); // 4500 + 4 × 300
    expect(b).toMatchObject({ listPrice: 9000, suggested: 9000 });                          // 2 turmas, 15 alunos cabem nos 20 incluídos
    expect(c).toMatchObject({ listPrice: null, suggested: 0, value: 3000 });               // sem tabela: valor digitado
    expect(proposal.calc.totals.total).toBe(17700);
    expect(proposal.draft.sections[0].items[0]).toMatchObject({ description: 'NR-35 Trabalho em Altura', extra: { students: 14, location: 'Planta do cliente' } });

    // mudar a tabela depois não muda a proposta já feita
    await api().put(`/commercial/course-prices/${course.id}`).set(auth(company.id)).send({ classPrice: 9000, includedStudents: 10, studentPrice: 300 }).expect(200);
    expect((await api().get(`/commercial/proposals/${proposal.id}`).set(auth(company.id))).body.calc.totals.total).toBe(17700);
    // curso de outra empresa não entra
    const foreign = await makeCourse((await makeCompany()).id);
    await api().put(`/commercial/course-prices/${foreign.id}`).set(auth(company.id)).send({ classPrice: 1 }).expect(404);
  });

  it('do rascunho ao aceite: parcelas, envio, revisão e decisão', async () => {
    const { company, customer, pro } = await cenario();
    const h = auth(company.id);
    const proposal = await criar(company.id, exemplo(customer.id, pro('Alpinista N1')));
    const status = (id: number, target: string, note?: string) => api().patch(`/commercial/proposals/status/${id}`).set(h).send({ status: target, note });

    // sem parcelas não envia; parcelas que não fecham também não
    await status(proposal.id, 'enviada').expect(400);
    const half = { percent: 0.5, dueRule: 'dias_apos_nf', dueDays: 28 };
    await api().put(`/commercial/proposals/${proposal.id}`).set(h).send({ ...proposal.draft, installments: [half] }).expect(200);
    await status(proposal.id, 'enviada').expect(400);
    const withPlan = (await api().put(`/commercial/proposals/${proposal.id}`).set(h)
      .send({ ...proposal.draft, installments: [{ ...half, description: 'Entrada' }, { amount: 10294.55, dueRule: 'data_fixa', dueDate: '2027-03-10' }] }).expect(200)).body;
    expect(withPlan.calc.installments.map((i: any) => i.value)).toEqual([10294.56, 10294.55]);
    expect(withPlan.calc.installmentsDiff).toBe(0);

    await status(proposal.id, 'aceita').expect(409); // rascunho não pula para aceita
    const sent = (await status(proposal.id, 'enviada').expect(200)).body;
    expect(sent).toMatchObject({ status: 'enviada', editable: false });
    expect(sent.sentAt).toBeTruthy();
    await api().put(`/commercial/proposals/${proposal.id}`).set(h).send(sent.draft).expect(409);
    await api().patch(`/commercial/proposals/inactive/${proposal.id}`).set(h).expect(409);

    // revisão: nova versão em rascunho, a anterior fica substituída e some da lista
    const revision = (await api().post(`/commercial/proposals/${proposal.id}/revise`).set(h).expect(201)).body;
    expect(revision).toMatchObject({ number: `PC-${YEAR}-0001-R1`, revision: 1, status: 'rascunho', rootId: proposal.id });
    expect(revision.calc.totals.total).toBe(20589.11);
    expect(revision.calc.installments).toHaveLength(2);
    expect(revision.versions.map((v: any) => [v.number, v.status])).toEqual([[`PC-${YEAR}-0001`, 'substituida'], [`PC-${YEAR}-0001-R1`, 'rascunho']]);
    await api().post(`/commercial/proposals/${proposal.id}/revise`).set(h).expect(409);
    const listed = (await api().get('/commercial/proposals').set(h).expect(200)).body;
    expect(listed.rows.map((r: any) => r.number)).toEqual([`PC-${YEAR}-0001-R1`]);
    expect((await api().get('/commercial/proposals?status=substituida').set(h)).body.rows).toHaveLength(1);

    // envia a revisão e o cliente aceita
    await status(revision.id, 'enviada').expect(200);
    const second = (await api().post(`/commercial/proposals/${revision.id}/revise`).set(h).expect(201)).body;
    expect(second.number).toBe(`PC-${YEAR}-0001-R2`);
    await status(second.id, 'enviada').expect(200);
    const accepted = (await status(second.id, 'aceita', 'Aceite por e-mail em 14/11').expect(200)).body;
    expect(accepted).toMatchObject({ status: 'aceita', statusNote: 'Aceite por e-mail em 14/11' });
    expect(accepted.decidedAt).toBeTruthy();
    await api().post(`/commercial/proposals/${second.id}/revise`).set(h).expect(409);
    await status(second.id, 'cancelada').expect(409);
    // a próxima proposta nova continua a sequência, sem pular por causa das revisões
    expect((await criar(company.id, { customerId: customer.id, title: 'Nova' })).number).toBe(`PC-${YEAR}-0002`);
  });

  it('duplicar cria outra proposta em rascunho; cancelar e inativar', async () => {
    const { company, customer, pro } = await cenario();
    const h = auth(company.id);
    const proposal = await criar(company.id, exemplo(customer.id, pro('Alpinista N1'), { installments: [{ percent: 1, dueRule: 'dias_apos_nf', dueDays: 30 }] }));
    const copy = (await api().post(`/commercial/proposals/${proposal.id}/duplicate`).set(h).expect(201)).body;
    expect(copy).toMatchObject({ number: `PC-${YEAR}-0002`, status: 'rascunho', revision: 0, rootId: null });
    expect(copy.draft.title).toBe('Jateamento de estrutura (cópia)');
    expect(copy.calc.totals.total).toBe(20589.11);
    expect(copy.calc.installments).toHaveLength(1);

    await api().patch(`/commercial/proposals/status/${copy.id}`).set(h).send({ status: 'cancelada', note: 'Cliente desistiu' }).expect(200);
    await api().patch(`/commercial/proposals/inactive/${copy.id}`).set(h).expect(200);
    expect((await api().get('/commercial/proposals').set(h)).body.rows.map((r: any) => r.id)).toEqual([proposal.id]);
    expect((await api().get('/commercial/proposals?inactive=true').set(h)).body.rows).toHaveLength(2);
    await api().patch(`/commercial/proposals/active/${copy.id}`).set(h).expect(200);
    await api().patch(`/commercial/proposals/status/${copy.id}`).set(h).send({ status: 'enviada' }).expect(409);
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'inventada' }).expect(400);
  });

  it('lista: busca por número, título e cliente, filtro por situação e resumo', async () => {
    const { company, customer, pro } = await cenario();
    const h = auth(company.id);
    const beta = await makeCustomer(company.id, 'Beta Engenharia');
    const a = await criar(company.id, exemplo(customer.id, pro('Alpinista N1'), { installments: [{ percent: 1, dueRule: 'dias_apos_nf', dueDays: 30 }], validUntil: '2020-01-01' }));
    // validade vencida não envia; com a data ajustada, sim
    await api().patch(`/commercial/proposals/status/${a.id}`).set(h).send({ status: 'enviada' }).expect(400);
    await api().put(`/commercial/proposals/${a.id}`).set(h).send({ ...a.draft, validUntil: '2099-12-31' }).expect(200);
    await criar(company.id, { kind: 'treinamento', customerId: beta.id, title: 'NR-35 para a equipe' });
    await api().patch(`/commercial/proposals/status/${a.id}`).set(h).send({ status: 'enviada' }).expect(200);

    const all = (await api().get('/commercial/proposals').set(h).expect(200)).body;
    expect(all.total).toBe(2);
    expect(all.summary).toMatchObject({ enviada: { count: 1, total: 20589.11 }, rascunho: { count: 1, total: 0 } });
    expect(all.rows.find((r: any) => r.id === a.id)).toMatchObject({ status: 'enviada', expired: false, customer: { name: 'Indústria Alfa' }, total: 20589.11 });
    const search = async (query: string) => (await api().get(`/commercial/proposals?${query}`).set(h).expect(200)).body.rows.map((r: any) => r.title);
    expect(await search('search=beta')).toEqual(['NR-35 para a equipe']);
    expect(await search('search=jateamento')).toEqual(['Jateamento de estrutura']);
    expect(await search(`search=PC-${YEAR}-0002`)).toEqual(['NR-35 para a equipe']);
    expect(await search('status=enviada')).toEqual(['Jateamento de estrutura']);
    expect(await search('kind=treinamento')).toEqual(['NR-35 para a equipe']);
    expect(await search(`customerId=${beta.id}`)).toEqual(['NR-35 para a equipe']);

    const customers = (await api().get('/commercial/proposals/customers?search=beta').set(h).expect(200)).body;
    expect(customers.map((c: any) => c.name)).toEqual(['Beta Engenharia']);
  });

  it('validações do corpo', async () => {
    const { company, customer, pro } = await cenario();
    const h = auth(company.id);
    const post = (body: Record<string, unknown>) => api().post('/commercial/proposals').set(h).send(body);
    await post({ customerId: customer.id, title: '' }).expect(400);
    await post({ title: 'Sem cliente' }).expect(400);
    await post({ customerId: 999999, title: 'Cliente inexistente' }).expect(400);
    await post(exemplo(customer.id, pro('Alpinista N1'), { workDays: 5, weekendDays: 6 })).expect(400);
    await post(exemplo(customer.id, 999999)).expect(400);
    await post({ customerId: customer.id, title: 'Item sem descrição', sections: [{ title: 'Extras', kind: 'avulso', items: [{ type: 'avulso', unitCost: 10 }] }] }).expect(400);
    await post(exemplo(customer.id, pro('Alpinista N1'), { installments: [{ percent: 0.5, amount: 100 }] })).expect(400);
    await post(exemplo(customer.id, pro('Alpinista N1'), { installments: [{ dueRule: 'data_fixa', percent: 1 }] })).expect(400);
    await post(exemplo(customer.id, pro('Alpinista N1'), { sections: [{ title: 'MDO', kind: 'mao_de_obra', margin: 0.8, items: [{ type: 'mao_de_obra', professionalId: pro('Alpinista N1') }] }] })).expect(400);
    await post({ customerId: customer.id, title: 'Vendedor de fora', sellerId: 999999 }).expect(400);
    expect(await testDb().commercial_Proposal.count()).toBe(0);
  });

  it('permissões e isolamento entre empresas', async () => {
    const { company, customer, pro } = await cenario();
    const proposal = await criar(company.id, exemplo(customer.id, pro('Alpinista N1')));
    await api().get('/commercial/proposals').expect(401);
    await api().get('/commercial/proposals').set(auth(company.id, ['list_financeiro'])).expect(403);
    const reader = auth(company.id, ['list_comercial']);
    await api().get(`/commercial/proposals/${proposal.id}`).set(reader).expect(200);
    await api().post('/commercial/proposals').set(reader).send({ customerId: customer.id, title: 'X' }).expect(403);
    await api().put(`/commercial/proposals/${proposal.id}`).set(reader).send(proposal.draft).expect(403);
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(reader).send({ status: 'cancelada' }).expect(403);
    await api().put('/commercial/course-prices/1').set(reader).send({}).expect(403);

    const other = await makeCompany();
    const otherCustomer = await makeCustomer(other.id, 'Gama');
    const foreign = auth(other.id);
    await api().get(`/commercial/proposals/${proposal.id}`).set(foreign).expect(404);
    await api().put(`/commercial/proposals/${proposal.id}`).set(foreign).send(proposal.draft).expect(404);
    await api().post(`/commercial/proposals/${proposal.id}/duplicate`).set(foreign).expect(404);
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(foreign).send({ status: 'cancelada' }).expect(404);
    expect((await api().get('/commercial/proposals').set(foreign).expect(200)).body.total).toBe(0);
    // cliente e profissional da outra empresa não entram na proposta
    await api().post('/commercial/proposals').set(foreign).send({ customerId: customer.id, title: 'Cliente alheio' }).expect(400);
    await api().post('/commercial/proposals').set(foreign).send(exemplo(otherCustomer.id, pro('Alpinista N1'))).expect(400);
    expect((await api().get('/commercial/proposals/customers').set(foreign).expect(200)).body.map((c: any) => c.name)).toEqual(['Gama']);
  });
});
