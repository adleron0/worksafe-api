import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Plano 08, fase 7: negociação (propostas do mesmo cliente agrupadas, cada uma
 * com o seu contrato e a sua NF) e o desconto de fechamento conjunto: desligado
 * por padrão, rateado (proporcional, igual ou à mão), em % ou R$, incondicional
 * ou condicionado (todas / as marcadas), e o que fazer se a condição cair
 * (avisar, recalcular entre as que ficaram ou retirar).
 */
describe('Negociação e desconto de fechamento conjunto (e2e)', () => {
  const ALL = [
    'list_comercial', 'create_comercial', 'update_comercial', 'view_custos_comercial',
    'list_itens_estoque', 'create_itens_estoque', 'update_itens_estoque', 'movimentar_estoque',
    'list_locacoes', 'create_locacoes', 'update_locacoes', 'list_financeiro', 'update_acompanhamento',
  ];
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => { blockRealNetwork(); jwt = (await bootTestApp()).get(JwtService); });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  beforeEach(async () => { await resetDb(); await flushCache(); resetAsaasMock(); });

  const auth = (companyId: number, permissions: string[] = ALL) => ({
    Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}`,
  });
  const api = () => request(httpServer());
  const cents = (value: number) => Math.round(value * 100) / 100;

  async function cenario() {
    const db = testDb();
    const company = await makeCompany({ system_domain: 'sistema.teste.local' });
    userId = (await makeSeller(company.id)).id;
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } });
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = (await db.dOM_Cities.findFirst()) ?? (await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } }));
    const customer = (name: string, cnpj: string) => db.customer.create({ data: {
      name, corporateName: `${name} SA`, cnpj, companyId: company.id, rankId: rank.id, phone: '8133334444', email: 'compras@beta.local', stateId: state.id, cityId: city.id,
    } });
    const beta = await customer('Refinaria Beta', '11222333000199');
    const other = await customer('Outra Ltda', '11222333000270');
    const h = auth(company.id);
    await api().get('/commercial/tax-profiles').set(h).expect(200);
    const main = (await api().get('/stock/locations').set(h).expect(200)).body[0];
    const tripe = (await api().post('/stock/items').set(h).send({
      name: 'Tripé com guincho 20 m', tracking: 'quantidade', returnable: true, rentable: true, replacementValue: 10050, lifeMonths: 60, rentMode: 'locacao',
    }).expect(201)).body;
    await api().post('/stock/movements').set(h).send({ type: 'entrada_avulsa', locationId: main.id, lines: [{ itemId: tripe.id, quantity: 2, unitCost: 8000 }] }).expect(201);

    const service = async (customerId: number, value: number, title = 'Linha de vida') => (await api().post('/commercial/proposals').set(h).send({
      kind: 'servico', customerId, title, contingencyRate: 0, installments: [{ percent: 1, dueRule: 'dias_apos_nf', dueDays: 10 }],
      sections: [{ title: 'Serviço', kind: 'avulso', items: [{ type: 'avulso', description: title, quantity: 1, finalValue: value }] }],
    }).expect(201)).body;
    const rental = async (customerId: number) => (await api().post('/commercial/proposals').set(h).send({
      kind: 'locacao', customerId, title: 'Tripé', contingencyRate: 0, rental: { period: 'mes', periods: 2, billing: 'periodo' },
      sections: [
        { title: 'Equipamentos', kind: 'locacao_cliente', items: [{ type: 'locacao_cliente', stockItemId: tripe.id, quantity: 1, extra: { period: 'mes', periods: 2, rate: 1000 } }] },
        { title: 'Frete', kind: 'avulso', items: [{ type: 'avulso', description: 'Frete de ida e volta', quantity: 1, finalValue: 200 }] },
      ],
    }).expect(201)).body;
    const status = (id: number, value: string) => api().patch(`/commercial/proposals/status/${id}`).set(h).send({ status: value });
    return { db, company, beta, other, h, main, tripe, service, rental, status };
  }

  it('agrupa propostas do mesmo cliente; desconto desligado por padrão; % rateado, valor em partes iguais com revisão da enviada; a OL nasce com o desconto', async () => {
    const { db, beta, other, h, service, rental, status } = await cenario();
    const s = await service(beta.id, 10000);
    const r = await rental(beta.id);
    const alien = await service(other.id, 500);

    // sem cliente: vem da primeira proposta
    const created = (await api().post('/commercial/deals').set(h).send({ proposalIds: [s.id, r.id] }).expect(201)).body;
    expect(created).toMatchObject({ number: expect.stringMatching(/^NG-\d{4}-0001$/), title: 'Negociação Refinaria Beta', status: 'aberta', customer: { id: beta.id } });
    expect(created.discount).toMatchObject({ enabled: false, type: 'percentual', value: 0, split: 'proporcional', condition: 'incondicional', onBreak: 'avisar' });
    expect(created.total).toBe(cents(s.calc.totals.total + r.calc.totals.total));
    expect(created.proposals.map((p: any) => [p.id, p.dealDiscount, p.action])).toEqual([[s.id, 0, 'igual'], [r.id, 0, 'igual']]);
    // a proposta mostra a negociação; proposta de outro cliente não entra
    expect((await api().get(`/commercial/proposals/${s.id}`).set(h).expect(200)).body.deal).toMatchObject({ id: created.id, number: created.number });
    await api().post(`/commercial/deals/${created.id}/proposals`).set(h).send({ proposalIds: [alien.id] }).expect(400);
    expect((await api().get(`/commercial/deals/${created.id}/candidates`).set(h).expect(200)).body).toEqual([]);
    // uma proposta só pode estar numa negociação
    await api().post('/commercial/deals').set(h).send({ customerId: beta.id, proposalIds: [s.id] }).expect(400);

    // 10% proporcional: a simulação mostra antes de gravar
    const baseS = created.proposals[0].base, baseR = created.proposals[1].base;
    const preview = (await api().post(`/commercial/deals/${created.id}/discount/preview`).set(h).send({ discount: { enabled: true, type: 'percentual', value: 0.1 } }).expect(201)).body;
    expect(preview.plan.map((p: any) => [p.planned, p.action])).toEqual([[cents(baseS * 0.1), 'gravar'], [cents(baseR * 0.1), 'gravar']]);
    await api().put(`/commercial/deals/${created.id}`).set(h).send({ discount: { enabled: true, type: 'percentual', value: 0.95 } }).expect(400);
    let deal = (await api().put(`/commercial/deals/${created.id}`).set(h).send({ discount: { enabled: true, type: 'percentual', value: 0.1 } }).expect(200)).body;
    expect(deal.pendingChanges).toBe(2);
    deal = (await api().post(`/commercial/deals/${created.id}/discount/apply`).set(h).send({}).expect(201)).body;
    expect(deal.pendingChanges).toBe(0);
    expect(deal.discount.appliedAt).toBeTruthy();
    expect(deal.discount).toMatchObject({ enabled: true });
    expect(deal.proposals.map((p: any) => p.dealDiscount)).toEqual([cents(baseS * 0.1), cents(baseR * 0.1)]);
    const sAfter = (await api().get(`/commercial/proposals/${s.id}`).set(h).expect(200)).body;
    expect(sAfter.calc.totals.dealDiscount).toBe(cents(baseS * 0.1));
    expect(sAfter.calc.totals.net).toBe(cents(baseS * 0.9));
    expect(deal.discount).toBeDefined();
    // a edição normal da proposta mantém a parte do desconto conjunto
    const edited = (await api().put(`/commercial/proposals/${s.id}`).set(h).send({ ...sAfter.draft, title: 'Linha de vida (rev)' }).expect(200)).body;
    expect(edited.calc.totals.dealDiscount).toBe(cents(baseS * 0.1));

    // a locação foi enviada; o desconto vira R$ 1.000 em partes iguais: enviada só muda por revisão
    await status(r.id, 'enviada').expect(200);
    await api().put(`/commercial/deals/${created.id}`).set(h).send({ discount: { type: 'valor', value: 1000, split: 'igual' } }).expect(200);
    await api().post(`/commercial/deals/${created.id}/discount/apply`).set(h).send({}).expect(409);
    deal = (await api().post(`/commercial/deals/${created.id}/discount/apply`).set(h).send({ reviseSent: true }).expect(201)).body;
    expect(deal.revised).toEqual([r.number]);
    const revision = await db.commercial_Proposal.findFirstOrThrow({ where: { rootId: r.id } });
    expect(revision).toMatchObject({ dealId: created.id, status: 'rascunho', number: `${r.number}-R1` });
    expect(Number(revision.dealDiscount)).toBe(500);
    expect((await db.commercial_Proposal.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('substituida');
    expect(deal.proposals.map((p: any) => [p.number, p.dealDiscount])).toEqual([[s.number, 500], [`${r.number}-R1`, 500]]);
    expect(deal.discount).toMatchObject({ type: 'valor', value: 1000 });

    // aceita a revisão: a OL nasce com o desconto nas tarifas e no frete
    await status(revision.id, 'enviada').expect(200);
    await status(revision.id, 'aceita').expect(200);
    const contract = await db.commercial_Contract.findFirstOrThrow({ where: { proposalId: revision.id } });
    const ol = await db.stock_Rental.findFirstOrThrow({ where: { contractId: contract.id }, include: { lines: true, charges: true } });
    const factor = (baseR - 500) / baseR;
    expect(Number(ol.lines[0].rate)).toBeCloseTo(1000 * factor, 2);
    expect(Number(ol.charges[0].value)).toBeCloseTo(200 * factor, 2);
    expect(Number(contract.value)).toBeCloseTo(r.calc.totals.total * factor, 1);

    // a aceita fica travada; mudar o desconto só mexe na que está aberta
    await api().put(`/commercial/deals/${created.id}`).set(h).send({ discount: { value: 1200 } }).expect(200);
    deal = (await api().post(`/commercial/deals/${created.id}/discount/apply`).set(h).send({}).expect(201)).body;
    expect(deal.proposals.map((p: any) => [p.dealDiscount, p.action])).toEqual([[700, 'igual'], [500, 'travada']]);
    expect(deal.status).toBe('aberta');
    await status(s.id, 'enviada').expect(200);
    await status(s.id, 'aceita').expect(200);
    deal = (await api().get(`/commercial/deals/${created.id}`).set(h).expect(200)).body;
    expect(deal).toMatchObject({ status: 'ganha', discount: { enabled: true } });
    expect(deal.discount).toBeDefined();
    expect(deal.won).toBe(deal.total);
    // a lista mostra a situação calculada
    const list = (await api().get('/commercial/deals').set(h).query({ status: 'ganha' }).expect(200)).body;
    expect(list.rows.map((d: any) => [d.number, d.statusLabel, d.discountTotal])).toEqual([[created.number, 'Ganha', 1200]]);
  });

  it('condição "só se fechar todas" com retirar; incondicional em R$ com recalcular; "as marcadas" com avisar', async () => {
    const { db, beta, h, service, status } = await cenario();
    const a = await service(beta.id, 6000, 'Serviço A');
    const b = await service(beta.id, 4000, 'Serviço B');
    let deal = (await api().post('/commercial/deals').set(h).send({ customerId: beta.id, title: 'Pacote parada', proposalIds: [a.id, b.id] }).expect(201)).body;
    const id = deal.id;
    await api().put(`/commercial/deals/${id}`).set(h).send({ discount: { enabled: true, type: 'percentual', value: 0.05, condition: 'todas', onBreak: 'retirar' } }).expect(200);
    deal = (await api().post(`/commercial/deals/${id}/discount/apply`).set(h).send({}).expect(201)).body;
    expect(deal.proposals.every((p: any) => p.dealDiscount > 0)).toBe(true);

    // B é recusada: a condição cai e o desconto sai de A (rascunho)
    await status(b.id, 'enviada').expect(200);
    await status(b.id, 'recusada').expect(200);
    deal = (await api().get(`/commercial/deals/${id}`).set(h).expect(200)).body;
    expect(deal.conditionHolds).toBe(false);
    expect(deal.breach).toMatchObject({ action: 'retirar', lost: [b.id], pending: [] });
    expect(deal.breach.reason).toMatch(/só se fechar todas/);
    expect(deal.proposals.find((p: any) => p.id === a.id).dealDiscount).toBe(0);
    expect(Number((await db.commercial_Proposal.findUniqueOrThrow({ where: { id: a.id } })).dealDiscount)).toBe(0);
    // aplicar de novo com a condição caída é recusado; o aviso some quando o vendedor dispensa
    await api().post(`/commercial/deals/${id}/discount/apply`).set(h).send({}).expect(400);
    deal = (await api().post(`/commercial/deals/${id}/breach/dismiss`).set(h).expect(201)).body;
    expect(deal.breach).toBeNull();

    // incondicional, R$ 900 proporcional, recalcular: C cancelada, A e D dividem os 900
    const c = await service(beta.id, 3000, 'Serviço C');
    const d = await service(beta.id, 3000, 'Serviço D');
    await api().post(`/commercial/deals/${id}/proposals`).set(h).send({ proposalIds: [c.id, d.id] }).expect(201);
    await api().put(`/commercial/deals/${id}`).set(h).send({ discount: { type: 'valor', value: 900, condition: 'incondicional', onBreak: 'recalcular', targets: [a.id, c.id, d.id] } }).expect(200);
    deal = (await api().post(`/commercial/deals/${id}/discount/apply`).set(h).send({}).expect(201)).body;
    const share = (pid: number) => deal.proposals.find((p: any) => p.id === pid).dealDiscount;
    expect(share(a.id) + share(c.id) + share(d.id)).toBeCloseTo(900, 2);
    // B foi perdida: fica como estava (não entra mais na conta)
    expect(deal.proposals.find((p: any) => p.id === b.id).action).toBe('fora');
    await status(c.id, 'cancelada').expect(200);
    deal = (await api().get(`/commercial/deals/${id}`).set(h).expect(200)).body;
    expect(deal.breach).toMatchObject({ action: 'recalcular', lost: expect.arrayContaining([b.id, c.id]) });
    expect(share(a.id) + share(d.id)).toBeCloseTo(900, 2);
    expect(share(a.id)).toBeGreaterThan(share(d.id));

    // à mão: cada proposta o seu; "as marcadas" com avisar não mexe em nada, só avisa
    await api().put(`/commercial/deals/${id}`).set(h).send({ discount: { split: 'manual', manual: { [a.id]: 300, [d.id]: 150 }, condition: 'marcadas', requiredIds: [], onBreak: 'avisar' } }).expect(400);
    await api().put(`/commercial/deals/${id}`).set(h).send({ discount: { split: 'manual', manual: { [a.id]: 300, [d.id]: 150 }, condition: 'marcadas', requiredIds: [d.id], onBreak: 'avisar' } }).expect(200);
    await api().post(`/commercial/deals/${id}/breach/dismiss`).set(h).expect(201);
    deal = (await api().post(`/commercial/deals/${id}/discount/apply`).set(h).send({}).expect(201)).body;
    expect([share(a.id), share(d.id)]).toEqual([300, 150]);
    await status(d.id, 'enviada').expect(200);
    await status(d.id, 'recusada').expect(200);
    deal = (await api().get(`/commercial/deals/${id}`).set(h).expect(200)).body;
    expect(deal.breach).toMatchObject({ action: 'avisar', pending: [a.id] });
    expect(share(a.id)).toBe(300);
    expect(deal.status).toBe('aberta');

    // tirar a proposta da negociação devolve o valor dela sem o desconto conjunto
    deal = (await api().delete(`/commercial/deals/${id}/proposals/${a.id}`).set(h).expect(200)).body;
    expect(deal.proposals.map((p: any) => p.id)).not.toContain(a.id);
    expect(Number((await db.commercial_Proposal.findUniqueOrThrow({ where: { id: a.id } })).dealDiscount)).toBe(0);
    expect(deal.status).toBe('perdida');
  });

  it('link único para o cliente (só as enviadas, cada uma com o link de aceite) e acompanhamento na negociação', async () => {
    const { beta, h, service, status } = await cenario();
    const a = await service(beta.id, 6000, 'Serviço A');
    const b = await service(beta.id, 4000, 'Serviço B');
    let deal = (await api().post('/commercial/deals').set(h).send({ customerId: beta.id, proposalIds: [a.id, b.id] }).expect(201)).body;
    expect(deal.publicUrl).toBeNull();
    deal = (await api().post(`/commercial/deals/${deal.id}/link`).set(h).expect(201)).body;
    expect(deal.publicUrl).toMatch(/^https:\/\/sistema\.teste\.local\/negociacao\/[a-f0-9-]+$/);
    const key = deal.publicUrl.split('/').pop();
    await status(a.id, 'enviada').expect(200);
    const view = (await api().get(`/commercial/public/deals/${key}`).expect(200)).body;
    expect(view).toMatchObject({ number: deal.number, customer: 'Refinaria Beta' });
    expect(view.proposals).toHaveLength(1);
    expect(view.proposals[0]).toMatchObject({ number: a.number, status: 'enviada', key: expect.any(String) });
    expect(view).not.toHaveProperty('notes');
    await api().get('/commercial/public/deals/00000000-0000-0000-0000-000000000000').expect(404);

    const activity = (await api().post('/commercial/activities').set(h).send({ dealId: deal.id, type: 'ligacao', subject: 'Retorno sobre o pacote', dueDate: '2026-12-01' }).expect(201)).body;
    expect(activity).toMatchObject({ deal: { id: deal.id, number: deal.number }, customer: { id: beta.id } });
    deal = (await api().get(`/commercial/deals/${deal.id}`).set(h).expect(200)).body;
    expect(deal.activities.map((x: any) => x.subject)).toEqual(['Retorno sobre o pacote']);
    expect((await api().get('/commercial/activities').set(h).query({ dealId: deal.id }).expect(200)).body.rows).toHaveLength(1);

    // negociação desfeita: as propostas voltam a ser avulsas
    await api().patch(`/commercial/deals/${deal.id}/inactive`).set(h).expect(200);
    await api().get(`/commercial/deals/${deal.id}`).set(h).expect(404);
    expect((await api().get(`/commercial/proposals/${a.id}`).set(h).expect(200)).body.deal).toBeNull();
  });
});
