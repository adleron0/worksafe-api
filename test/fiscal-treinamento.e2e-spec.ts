import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as nock from 'nock';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { makeTestPfx } from 'src/features/fiscal/test-certificate';
import { packXml, SEFIN_URLS, unpackXml } from 'src/features/fiscal/sefin.client';
import { FiscalTrainingJob } from 'src/features/fiscal/training.job';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Área fiscal, fase I4: nota da inscrição paga em turma aberta (aluno pessoa
 * física ou várias inscrições da mesma empresa), fila de inscrições pagas sem
 * nota e emissão automática opcional. Vaga paga por contrato fica de fora.
 */
process.env.FISCAL_SECRET = 'chave-fiscal-de-teste-com-32-chars!!';

describe('Área fiscal — nota da inscrição (e2e)', () => {
  const ALL = ['view_nfse', 'emitir_nfse', 'cancelar_nfse', 'config_fiscal', 'list_financeiro'];
  const SEFIN = SEFIN_URLS.restrita;
  const key = (n: number) => `2611606212345678000195000000000000${String(n).padStart(4, '0')}26110000000001`.slice(0, 50);
  let jwt: JwtService;
  let job: FiscalTrainingJob;
  let userId = 0;

  beforeAll(async () => { blockRealNetwork(); const app = await bootTestApp(); jwt = app.get(JwtService); job = app.get(FiscalTrainingJob); });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); nock.cleanAll(); });
  beforeEach(async () => { await resetDb(); await flushCache(); nock.cleanAll(); });

  const auth = (companyId: number) => ({ Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions: ALL, profile: 'admin' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` });
  const api = () => request(httpServer());
  const nfse = (k: string, n: string) => `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${k}"><nNFSe>${n}</nNFSe><cStat>100</cStat><dhProc>2026-11-25T12:00:01-03:00</dhProc><valores><vLiq>1.00</vLiq></valores><DPS/></infNFSe></NFSe>`;

  async function cenario() {
    const db = testDb();
    const state = await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } });
    const city = await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } });
    const company = await makeCompany({ cnpj: '12345678000195', stateId: state.id, cityId: city.id });
    userId = (await makeSeller(company.id)).id;
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } });
    const customer = await db.customer.create({ data: {
      name: 'Alfa', corporateName: 'Indústria Alfa SA', cnpj: '11222333000181', companyId: company.id, rankId: rank.id, email: 'nf@alfa.local',
      stateId: state.id, cityId: city.id, street: 'Rua do Bom Jesus', number: 123, neighborhood: 'Recife Antigo', zipcode: '50030230',
    } });
    const h = auth(company.id);
    await api().put('/fiscal/settings').set(h).send({ simplesNacional: 3, simplesRegime: 1, simplesTotalRate: 6, autoSendEmail: false }).expect(200);
    await api().post('/fiscal/settings/certificate').set(h).field('password', 'teste123').attach('file', makeTestPfx('12345678000195'), 'e.pfx').expect(200);
    await api().post('/fiscal/service-codes').set(h).send({ name: 'Serviço em altura', nationalCode: '070202', description: 'Serviço.', isDefault: true }).expect(201);
    await api().post('/fiscal/service-codes').set(h).send({ name: 'Treinamento', nationalCode: '080201', issRate: 5, description: 'Treinamento.' }).expect(201);
    const course = await makeCourse(company.id);
    const klass = await makeCourseClass(company.id, course.id, { name: 'Turma 12' });
    const subscribe = async (name: string, cpf: string, extra: Record<string, unknown> = {}, paid = true) => {
      const sub = await db.courseClassSubscription.create({ data: { name, cpf, email: `${cpf}@aluno.local`, phone: '81999990000', classId: klass.id, companyId: company.id, subscribeStatus: 'confirmed', ...extra } });
      await db.financialRecords.create({ data: { companyId: company.id, gateway: 'manual', status: paid ? 'received' : 'waiting', paymentMethod: 'pix', value: 500, paidAt: paid ? new Date() : null, accrualDate: '2026-11', subscriptionId: sub.id, customerId: (extra.customerId as number) ?? null } });
      return sub;
    };
    return { company, customer, h, subscribe };
  }

  it('fila de pagas sem nota, nota do aluno (CPF) ligada ao pagamento e cancelamento que não mexe no pagamento', async () => {
    const { h, subscribe } = await cenario();
    const joao = await subscribe('João da Silva', '52998224725');
    await subscribe('Pagando Ainda', '11144477735', {}, false);
    await subscribe('Vaga do Contrato', '39053344705', { contractId: 99 });

    const pending = (await api().get('/fiscal/training/pending').set(h).expect(200)).body;
    expect(pending.map((p: any) => p.name)).toEqual(['João da Silva']);

    const draft = (await api().get('/fiscal/invoices/from-origin').query({ kind: 'subscriptions', subscriptionIds: String(joao.id) }).set(h).expect(200)).body;
    expect(draft.takerKind).toBe('avulso');
    expect(draft.taker.document).toBe('52998224725');
    expect(draft.grossValue).toBe(500);
    expect(draft.originLabel).toContain('João da Silva');

    let sent = '';
    nock(SEFIN).post('/nfse', (b) => { sent = unpackXml(b.dpsXmlGZipB64); return true; }).reply(201, { chaveAcesso: key(1), nfseXmlGZipB64: packXml(nfse(key(1), '90')) });
    const inv = (await api().post('/fiscal/invoices').set(h).send({ ...draft, emit: true }).expect(201)).body;
    expect(inv.status).toBe('autorizada');
    expect(sent).toContain('<CPF>52998224725</CPF>');
    expect(sent).toContain('<cTribNac>080201</cTribNac>');
    const rec = await testDb().financialRecords.findFirstOrThrow({ where: { subscriptionId: joao.id } });
    expect(rec.fiscalInvoiceId).toBe(inv.id);
    expect(rec.invoiceNumber).toBe('90');
    expect((await api().get('/fiscal/training/pending').set(h).expect(200)).body).toEqual([]);
    // outra nota para a mesma inscrição é recusada
    await api().get('/fiscal/invoices/from-origin').query({ kind: 'subscriptions', subscriptionIds: String(joao.id) }).set(h).expect(409);

    // cancelar a nota de inscrição paga é permitido e o pagamento continua recebido
    nock(SEFIN).post(`/nfse/${key(1)}/eventos`).reply(201, { eventoXmlGZipB64: packXml('<evento><cStat>135</cStat></evento>') });
    await api().post(`/fiscal/invoices/${inv.id}/cancel`).set(h).send({ reasonCode: 1, reason: 'Nome do aluno digitado errado' }).expect(200);
    const after = await testDb().financialRecords.findFirstOrThrow({ where: { subscriptionId: joao.id } });
    expect(after.status).toBe('received');
    expect(after.fiscalInvoiceId).toBeNull();
    expect((await api().get('/fiscal/training/pending').set(h).expect(200)).body.map((p: any) => p.name)).toEqual(['João da Silva']);
  });

  it('várias inscrições da mesma empresa numa nota só; empresas diferentes não', async () => {
    const { h, customer, subscribe } = await cenario();
    const a = await subscribe('Ana', '52998224725', { customerId: customer.id });
    const b = await subscribe('Bruno', '11144477735', { customerId: customer.id });
    const c = await subscribe('Carla', '39053344705');
    await api().get('/fiscal/invoices/from-origin').query({ kind: 'subscriptions', subscriptionIds: `${a.id},${c.id}` }).set(h).expect(400);
    const draft = (await api().get('/fiscal/invoices/from-origin').query({ kind: 'subscriptions', subscriptionIds: `${a.id},${b.id}` }).set(h).expect(200)).body;
    expect(draft.takerKind).toBe('cliente');
    expect(draft.customerId).toBe(customer.id);
    expect(draft.grossValue).toBe(1000);
    nock(SEFIN).post('/nfse').reply(201, { chaveAcesso: key(2), nfseXmlGZipB64: packXml(nfse(key(2), '91')) });
    const inv = (await api().post('/fiscal/invoices').set(h).send({ ...draft, emit: true }).expect(201)).body;
    expect(inv.status).toBe('autorizada');
    expect(await testDb().financialRecords.count({ where: { fiscalInvoiceId: inv.id } })).toBe(2);
  });

  it('emissão automática: só pagamentos depois de ligar; dado faltando vira rascunho na fila', async () => {
    const { company, h, subscribe } = await cenario();
    await subscribe('Antigo', '52998224725');
    await new Promise((r) => setTimeout(r, 20));
    const settings = (await api().put('/fiscal/settings').set(h).send({ autoEmitTraining: true }).expect(200)).body;
    expect(settings.autoEmitTraining).toBe(true);
    const novo = await subscribe('Novo Aluno', '11144477735');
    const semCpf = await subscribe('Sem CPF', '123');
    nock(SEFIN).post('/nfse').reply(201, { chaveAcesso: key(3), nfseXmlGZipB64: packXml(nfse(key(3), '92')) });
    const row = await testDb().fiscal_Settings.findFirstOrThrow({ where: { companyId: company.id } });
    const tried = await job.runCompany(company.id, row.autoEmitTrainingSince, userId);
    expect(tried).toBe(2);
    const rec = await testDb().financialRecords.findFirstOrThrow({ where: { subscriptionId: novo.id } });
    expect(rec.invoiceNumber).toBe('92');
    const pending = (await api().get('/fiscal/training/pending').set(h).expect(200)).body;
    // o antigo (pago antes de ligar) e o sem CPF (rascunho) continuam na fila; o antigo não foi tentado
    expect(pending.find((p: any) => p.name === 'Antigo').invoice).toBeNull();
    expect(pending.find((p: any) => p.subscriptionId === semCpf.id).invoice.status).toBe('rascunho');
    // a segunda rodada não tenta de novo
    expect(await job.runCompany(company.id, row.autoEmitTrainingSince, userId)).toBe(0);
  });
});
