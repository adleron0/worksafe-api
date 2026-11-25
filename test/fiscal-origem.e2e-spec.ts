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
 * Área fiscal, fase I2: a nota nasce da parcela da proposta; ao ser autorizada,
 * o sistema fatura a parcela com o número da nota. Desfaturar por fora é
 * travado e cancelar a nota desfaz o faturamento.
 */
process.env.FISCAL_SECRET = 'chave-fiscal-de-teste-com-32-chars!!';

describe('Área fiscal — nota da parcela (e2e)', () => {
  const COMMERCIAL = ['list_comercial', 'create_comercial', 'update_comercial', 'inactive_comercial', 'activate_comercial', 'view_custos_comercial'];
  const FINANCE = ['list_financeiro', 'create_financeiro', 'update_financeiro', 'inactive_financeiro'];
  const FISCAL = ['view_nfse', 'emitir_nfse', 'cancelar_nfse', 'config_fiscal'];
  const ALL = [...COMMERCIAL, ...FINANCE, ...FISCAL];
  const SEFIN = SEFIN_URLS.restrita;
  const CHAVE = '26116062123456780001950000000000000126110000000001';
  let jwt: JwtService;
  let userId = 0;
  let ipSeq = 0;

  beforeAll(async () => { blockRealNetwork(); jwt = (await bootTestApp()).get(JwtService); });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); nock.cleanAll(); });
  beforeEach(async () => { await resetDb(); await flushCache(); nock.cleanAll(); });

  const auth = (companyId: number, permissions: string[] = ALL) => ({
    Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}`,
  });
  const api = () => request(httpServer());
  const nfseXml = (key: string, number: string) =>
    `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${key}"><nNFSe>${number}</nNFSe><cStat>100</cStat><dhProc>2026-11-25T12:00:01-03:00</dhProc><valores><vLiq>1.00</vLiq></valores><DPS/></infNFSe></NFSe>`;

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
    await api().post('/fiscal/service-codes').set(h).send({ name: 'Serviço em altura', nationalCode: '070202', issRate: 5, description: 'Serviço para {cliente}.', isDefault: true }).expect(201);

    const options = (await api().get('/commercial/proposals/options').set(h).expect(200)).body;
    const professionalId = options.professionals.find((p: any) => p.name === 'Alpinista N1').id;
    const proposal = (await api().post('/commercial/proposals').set(h).send({
      kind: 'servico', customerId: customer.id, title: 'Jateamento de estrutura', contactName: 'Maria Souza', workDays: 22, contingencyRate: 0.05,
      sections: [{ title: 'Mão de obra', kind: 'mao_de_obra', margin: 0.26, items: [{ type: 'mao_de_obra', professionalId, quantity: 1 }] }],
      installments: [
        { percent: 0.5, dueRule: 'dias_apos_aceite', dueDays: 5, description: 'Entrada' },
        { percent: 0.5, dueRule: 'dias_apos_nf', dueDays: 28, description: 'Saldo' },
      ],
    }).expect(201)).body;
    const sent = (await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'enviada' }).expect(200)).body;
    await api().post(`/commercial/public/proposals/${sent.publicKey}/accept`).set('X-Forwarded-For', `192.0.2.${++ipSeq}`)
      .send({ name: 'Maria Souza', cpf: '529.982.247-25', role: 'Gerente', email: 'maria@alfa.local', declaration: true, termsAccepted: true }).expect(201);
    const list = (await api().get('/commercial/contracts').set(h).expect(200)).body;
    const contract = (await api().get(`/commercial/contracts/${list.rows[0].id}`).set(h).expect(200)).body;
    await api().put(`/commercial/contracts/${contract.id}/retention-rates`).set(h).send({ rates: { iss: 5, ir: 1.5 } }).expect(200);
    return { company, customer, contract, h };
  }

  it('nota da parcela: sugere, emite, fatura a parcela com o número da nota e o cancelamento desfaz', async () => {
    const { contract, h } = await cenario();
    const inst = contract.installments[0];
    const value = Number(inst.value);

    const draft = (await api().get('/fiscal/invoices/from-origin').query({ kind: 'installments', contractId: contract.id, installmentIds: String(inst.id) }).set(h).expect(200)).body;
    expect(draft.grossValue).toBe(value);
    expect(draft.issWithheld).toBe(true);
    expect(draft.retentions).toEqual({ ir: { rate: 1.5 } });
    expect(draft.originLabel).toContain('parcela 1/2');

    // valor diferente da parcela não emite (sugestivo: aponta o erro na prévia)
    const wrong = (await api().post('/fiscal/invoices/preview').set(h).send({ ...draft, grossValue: value + 10 }).expect(200)).body;
    expect(wrong.canEmit).toBe(false);
    expect(wrong.errors.join(' ')).toMatch(/valor da nota precisa ser o da origem/);

    let sentXml = '';
    nock(SEFIN).post('/nfse', (b) => { sentXml = unpackXml(b.dpsXmlGZipB64); return true; }).reply(201, { chaveAcesso: CHAVE, nfseXmlGZipB64: packXml(nfseXml(CHAVE, '55')) });
    const invoice = (await api().post('/fiscal/invoices').set(h).send({ ...draft, emit: true }).expect(201)).body;
    expect(invoice.status).toBe('autorizada');
    expect(invoice.originBilledAt).toBeTruthy();
    expect(sentXml).toContain('<tpRetISSQN>2</tpRetISSQN>');
    expect(sentXml).toMatch(/<docRef>Proposta PC-\d{4}-\d+ · Contrato CT-/);

    // a parcela foi faturada com o número da nota, ligada à nota, com as retenções
    const after = (await api().get(`/commercial/contracts/${contract.id}`).set(h).expect(200)).body;
    const billed = after.installments.find((i: any) => i.id === inst.id);
    expect(billed.record.invoiceNumber).toBe('55');
    const record = await testDb().financialRecords.findUniqueOrThrow({ where: { id: billed.record.id }, include: { retentions: true } });
    expect(record.fiscalInvoiceId).toBe(invoice.id);
    expect(record.retentions.map((r) => r.tax).sort()).toEqual(['ir', 'iss']);
    expect(record.retentions.every((r) => r.fiscalInvoiceId === invoice.id)).toBe(true);
    expect(invoice.receivables).toHaveLength(1);

    // outra nota para a mesma parcela é recusada
    await api().post('/fiscal/invoices').set(h).send(draft).expect(409);
    // desfaturar por fora é travado: o caminho é cancelar a nota
    const blocked = await api().post(`/commercial/contracts/${contract.id}/installments/${inst.id}/unbill`).set(h).expect(409);
    expect(blocked.body.message).toMatch(/NFS-e nº 55/);

    nock(SEFIN).post(`/nfse/${CHAVE}/eventos`).reply(201, { eventoXmlGZipB64: packXml('<evento><cStat>135</cStat></evento>') });
    const cancelled = (await api().post(`/fiscal/invoices/${invoice.id}/cancel`).set(h).send({ reasonCode: 1, reason: 'Valor da parcela informado errado' }).expect(200)).body;
    expect(cancelled.status).toBe('cancelada');
    expect(cancelled.messages).toEqual([]);
    const reopened = (await api().get(`/commercial/contracts/${contract.id}`).set(h).expect(200)).body;
    expect(reopened.installments.find((i: any) => i.id === inst.id).record).toBeFalsy();

    // agora dá para emitir de novo para a parcela
    const again = (await api().get('/fiscal/invoices/from-origin').query({ kind: 'installments', contractId: contract.id, installmentIds: String(inst.id) }).set(h).expect(200)).body;
    expect(again.grossValue).toBe(value);
  });

  it('rejeição não fatura; corrigir e reenviar fatura uma vez só', async () => {
    const { contract, h } = await cenario();
    const inst = contract.installments[1];
    const draft = (await api().get('/fiscal/invoices/from-origin').query({ kind: 'installments', contractId: contract.id, installmentIds: String(inst.id) }).set(h).expect(200)).body;
    nock(SEFIN).post('/nfse').reply(400, { erros: [{ Codigo: 'E0312', Descricao: 'Código não administrado' }] });
    const rejected = (await api().post('/fiscal/invoices').set(h).send({ ...draft, emit: true }).expect(201)).body;
    expect(rejected.status).toBe('rejeitada');
    let after = (await api().get(`/commercial/contracts/${contract.id}`).set(h).expect(200)).body;
    expect(after.installments.find((i: any) => i.id === inst.id).record).toBeFalsy();
    nock(SEFIN).post('/nfse').reply(201, { chaveAcesso: CHAVE, nfseXmlGZipB64: packXml(nfseXml(CHAVE, '56')) });
    const ok = (await api().post(`/fiscal/invoices/${rejected.id}/emit`).set(h).expect(200)).body;
    expect(ok.status).toBe('autorizada');
    after = (await api().get(`/commercial/contracts/${contract.id}`).set(h).expect(200)).body;
    expect(after.installments.find((i: any) => i.id === inst.id).record.invoiceNumber).toBe('56');
    expect(await testDb().financialRecords.count({ where: { contractInstallmentId: inst.id, inactiveAt: null } })).toBe(1);
  });
});
