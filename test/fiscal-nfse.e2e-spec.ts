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
 * Área fiscal (NFS-e Nacional): configuração, nota avulsa, emissão pela Sefin
 * (simulada com nock), rejeição, envio interrompido, cancelamento e
 * substituição. Nenhuma chamada sai da máquina.
 */
process.env.FISCAL_SECRET = 'chave-fiscal-de-teste-com-32-chars!!';

describe('Área fiscal — NFS-e nacional (e2e)', () => {
  const FISCAL = ['view_nfse', 'emitir_nfse', 'cancelar_nfse', 'config_fiscal', 'list_financeiro'];
  const SEFIN = SEFIN_URLS.restrita;
  const CHAVE = '26116062123456780001950000000000000126110000000001';
  const CHAVE2 = '26116062123456780001950000000000000226110000000002';
  let jwt: JwtService;
  let userId = 0;
  let companyCnpj = '';

  beforeAll(async () => {
    blockRealNetwork();
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); nock.cleanAll(); });
  beforeEach(async () => { await resetDb(); await flushCache(); nock.cleanAll(); });

  const auth = (companyId: number, permissions: string[] = FISCAL) => ({
    Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}`,
  });
  const api = () => request(httpServer());

  const nfseXml = (key: string, number: string, net = '1500.00') =>
    `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${key}"><xLocEmi>Recife</xLocEmi><xLocPrestacao>Recife</xLocPrestacao><nNFSe>${number}</nNFSe><xTribNac>Instrução</xTribNac><verAplic>SefinNac</verAplic><ambGer>2</ambGer><tpEmis>1</tpEmis><cStat>100</cStat><dhProc>2026-11-25T12:00:01-03:00</dhProc><nDFSe>1</nDFSe><valores><vLiq>${net}</vLiq></valores><DPS/></infNFSe></NFSe>`;

  /** Empresa em Recife com certificado, série e um serviço fiscal: pronta para emitir. */
  async function cenario() {
    const db = testDb();
    const state = await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } });
    const city = await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } });
    companyCnpj = '12345678000195';
    const company = await makeCompany({ cnpj: companyCnpj, stateId: state.id, cityId: city.id, address: 'Rua da Aurora', addressNumber: '100', neighborhood: 'Boa Vista' });
    userId = (await makeSeller(company.id)).id;
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId: company.id } });
    const customer = await db.customer.create({ data: {
      name: 'Alfa', corporateName: 'Indústria Alfa SA', cnpj: '11222333000181', companyId: company.id, rankId: rank.id,
      email: 'compras@alfa.local', stateId: state.id, cityId: city.id, street: 'Rua do Bom Jesus', number: 123, neighborhood: 'Recife Antigo', zipcode: '50030230',
    } });
    await db.customer_Contacts.create({ data: { companyId: company.id, customerId: customer.id, name: 'Fiscal Alfa', email: 'nf@alfa.local', phone: '81999990000', isFiscal: true, defaultFiscal: true } });
    const h = auth(company.id);

    const first = (await api().get('/fiscal/settings').set(h).expect(200)).body;
    expect(first.ready).toBe(false);
    expect(first.emitter.ibge).toBe('2611606');
    expect(first.pending.join(' ')).toMatch(/certificado/);

    await api().put('/fiscal/settings').set(h).send({ simplesNacional: 3, simplesRegime: 1, simplesTotalRate: 6, dpsSeries: '900', autoSendEmail: false }).expect(200);
    const pfx = makeTestPfx(companyCnpj);
    const withCert = (await api().post('/fiscal/settings/certificate').set(h).field('password', 'teste123').attach('file', pfx, 'empresa.pfx').expect(200)).body;
    expect(withCert.hasCertificate).toBe(true);
    expect(withCert.certificateDocument).toBe(companyCnpj);
    expect(JSON.stringify(withCert)).not.toContain('certificateEncrypted');

    const service = (await api().post('/fiscal/service-codes').set(h).send({ name: 'Treinamento NR-35', nationalCode: '080201', nbsCode: '122051900', issRate: 5, description: 'Treinamento de trabalho em altura (NR-35) para {cliente}, competência {competencia}.', isDefault: true }).expect(201)).body;
    const ready = (await api().get('/fiscal/settings').set(h).expect(200)).body;
    expect(ready.pending).toEqual([]);
    expect(ready.ready).toBe(true);
    return { company, customer, service, h };
  }

  const draftBody = (customerId: number, serviceCodeId: number, extra: Record<string, unknown> = {}) => ({
    takerKind: 'cliente', customerId, serviceCodeId, grossValue: 1500, competence: new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10),
    receivable: { create: true, dueDate: new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10) },
    ...extra,
  });

  it('configuração: recusa certificado de outro CNPJ e senha errada', async () => {
    const { h } = await cenario();
    await api().post('/fiscal/settings/certificate').set(h).field('password', 'errada').attach('file', makeTestPfx(companyCnpj), 'x.pfx').expect(400);
    const other = await api().post('/fiscal/settings/certificate').set(h).field('password', 'teste123').attach('file', makeTestPfx('99888777000166'), 'x.pfx').expect(400);
    expect(other.body.message).toMatch(/outro|CNPJ/);
    const codes = (await api().get('/fiscal/catalog/services?q=0802').set(h).expect(200)).body;
    expect(codes.some((c: any) => c.code === '080201')).toBe(true);
  });

  it('prévia: preenche a discriminação pelo modelo e aponta o que falta', async () => {
    const { customer, service, h } = await cenario();
    const ok = (await api().post('/fiscal/invoices/preview').set(h).send(draftBody(customer.id, service.id)).expect(200)).body;
    expect(ok.canEmit).toBe(true);
    expect(ok.description).toContain('Indústria Alfa SA');
    expect(ok.taker.email).toBe('nf@alfa.local');
    expect(ok.warnings.join(' ')).toMatch(/testes/);
    const semEndereco = (await api().post('/fiscal/invoices/preview').set(h).send(draftBody(customer.id, service.id, { taker: { address: { street: '' } } })).expect(200)).body;
    expect(semEndereco.canEmit).toBe(false);
    expect(semEndereco.errors.join(' ')).toMatch(/endereço completo/);
  });

  it('emite a nota avulsa: DPS assinada, número e chave gravados, conta a receber com retenções', async () => {
    const { customer, service, h } = await cenario();
    let sentXml = '';
    nock(SEFIN).post('/nfse', (body) => { sentXml = unpackXml(body.dpsXmlGZipB64); return true; })
      .reply(201, { chaveAcesso: CHAVE, nfseXmlGZipB64: packXml(nfseXml(CHAVE, '17', '1350.00')) });
    const draft = (await api().post('/fiscal/invoices').set(h).send(draftBody(customer.id, service.id, { issWithheld: true, retentions: { ir: { rate: 1.5 }, csll: { rate: 1 }, pis: { rate: 0.65 }, cofins: { rate: 3 } } })).expect(201)).body;
    expect(draft.status).toBe('rascunho');
    expect(draft.netValue).toBe(1500 - 75 - 22.5 - 15 - 9.75 - 45);
    const emitted = (await api().post(`/fiscal/invoices/${draft.id}/emit`).set(h).expect(200)).body;
    expect(emitted.status).toBe('autorizada');
    expect(emitted.number).toBe('17');
    expect(emitted.accessKey).toBe(CHAVE);
    expect(emitted.dpsSeries).toBe('900');
    expect(emitted.dpsNumber).toBe(1);
    expect(sentXml).toContain('<Signature');
    expect(sentXml).toContain('<tpRetISSQN>2</tpRetISSQN><pAliq>5.00</pAliq>');
    expect(sentXml).toContain('<pTotTribSN>6.00</pTotTribSN>');
    expect(sentXml).not.toContain('<xNome>WorkSafe');
    // conta a receber nasce com o líquido e as retenções no relatório
    expect(emitted.receivables).toHaveLength(1);
    expect(emitted.receivables[0].netValue).toBe(emitted.netValue);
    const ret = await testDb().financial_Retention.findMany({ where: { fiscalInvoiceId: draft.id }, orderBy: { tax: 'asc' } });
    expect(ret.map((r) => r.tax).sort()).toEqual(['cofins', 'csll', 'ir', 'iss', 'pis']);
    expect(ret.every((r) => r.invoiceNumber === '17')).toBe(true);
    const pdf = await api().get(`/fiscal/invoices/${draft.id}/pdf`).set(h).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const xml = await api().get(`/fiscal/invoices/${draft.id}/xml`).set(h).expect(200);
    expect(String(xml.text ?? xml.body)).toContain(CHAVE);
    const list = (await api().get('/fiscal/invoices?q=Alfa').set(h).expect(200)).body;
    expect(list.total).toBe(1);
    expect(list.summary.authorized).toBe(1);
  });

  it('rejeição: guarda as mensagens e reenvia com o mesmo número depois de corrigir', async () => {
    const { customer, service, h } = await cenario();
    nock(SEFIN).post('/nfse').reply(400, { erros: [{ Codigo: 'E0312', Descricao: 'Código de tributação não administrado pelo município' }] });
    const draft = (await api().post('/fiscal/invoices').set(h).send({ ...draftBody(customer.id, service.id), emit: true }).expect(201)).body;
    expect(draft.status).toBe('rejeitada');
    expect(draft.messages[0].code).toBe('E0312');
    expect(draft.dpsNumber).toBe(1);
    let sent = '';
    nock(SEFIN).post('/nfse', (b) => { sent = unpackXml(b.dpsXmlGZipB64); return true; }).reply(201, { chaveAcesso: CHAVE, nfseXmlGZipB64: packXml(nfseXml(CHAVE, '18')) });
    const again = (await api().put(`/fiscal/invoices/${draft.id}`).set(h).send({ ...draftBody(customer.id, service.id), emit: true }).expect(200)).body;
    expect(again.status).toBe('autorizada');
    expect(again.dpsNumber).toBe(1);
    expect(sent).toContain('<nDPS>1</nDPS>');
  });

  it('envio interrompido: fica "enviando" e a conferência busca a nota que foi gerada', async () => {
    const { customer, service, h } = await cenario();
    nock(SEFIN).post('/nfse').replyWithError({ code: 'ECONNRESET', message: 'socket hang up' });
    const draft = (await api().post('/fiscal/invoices').set(h).send({ ...draftBody(customer.id, service.id), emit: true }).expect(201)).body;
    expect(draft.status).toBe('emitindo');
    expect(draft.messages[0].message).toMatch(/Conferir/);
    nock(SEFIN).get(`/dps/${draft.dpsId}`).reply(200, { chaveAcesso: CHAVE });
    nock(SEFIN).get(`/nfse/${CHAVE}`).reply(200, { nfseXmlGZipB64: packXml(nfseXml(CHAVE, '19')) });
    const checked = (await api().post(`/fiscal/invoices/${draft.id}/check`).set(h).expect(200)).body;
    expect(checked.status).toBe('autorizada');
    expect(checked.number).toBe('19');
    expect(checked.receivables).toHaveLength(1); // não duplica
  });

  it('cancela a nota e a conta a receber aberta; bloqueia quando já recebida', async () => {
    const { company, customer, service, h } = await cenario();
    nock(SEFIN).post('/nfse').reply(201, { chaveAcesso: CHAVE, nfseXmlGZipB64: packXml(nfseXml(CHAVE, '20')) });
    const inv = (await api().post('/fiscal/invoices').set(h).send({ ...draftBody(customer.id, service.id), emit: true }).expect(201)).body;
    await api().post(`/fiscal/invoices/${inv.id}/cancel`).set(h).send({ reasonCode: 1, reason: 'curto' }).expect(400);
    await api().post(`/fiscal/invoices/${inv.id}/cancel`).set(auth(company.id, ['view_nfse', 'emitir_nfse'])).send({ reasonCode: 1, reason: 'Valor informado errado na emissão' }).expect(403);
    let eventXml = '';
    nock(SEFIN).post(`/nfse/${CHAVE}/eventos`, (b) => { eventXml = unpackXml(b.pedidoRegistroEventoXmlGZipB64); return true; })
      .reply(201, { eventoXmlGZipB64: packXml('<evento><infEvento><cStat>135</cStat><dhProc>2026-11-25T13:00:00-03:00</dhProc></infEvento></evento>') });
    const cancelled = (await api().post(`/fiscal/invoices/${inv.id}/cancel`).set(h).send({ reasonCode: 1, reason: 'Valor informado errado na emissão' }).expect(200)).body;
    expect(cancelled.status).toBe('cancelada');
    expect(eventXml).toContain('<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo>');
    expect(eventXml).toContain(`Id="PRE${CHAVE}101101"`);
    expect(cancelled.receivables[0].status).toBe('cancelled');

    nock(SEFIN).post('/nfse').reply(201, { chaveAcesso: CHAVE2, nfseXmlGZipB64: packXml(nfseXml(CHAVE2, '21')) });
    const paid = (await api().post('/fiscal/invoices').set(h).send({ ...draftBody(customer.id, service.id), emit: true }).expect(201)).body;
    await testDb().financialRecords.update({ where: { id: paid.receivables[0].id }, data: { status: 'received', paidAt: new Date() } });
    const blocked = await api().post(`/fiscal/invoices/${paid.id}/cancel`).set(h).send({ reasonCode: 1, reason: 'Valor informado errado na emissão' }).expect(400);
    expect(blocked.body.message).toMatch(/substitua/);
  });

  it('substitui a nota: a nova leva o grupo subst e assume a conta a receber', async () => {
    const { customer, service, h } = await cenario();
    nock(SEFIN).post('/nfse').reply(201, { chaveAcesso: CHAVE, nfseXmlGZipB64: packXml(nfseXml(CHAVE, '30')) });
    const original = (await api().post('/fiscal/invoices').set(h).send({ ...draftBody(customer.id, service.id), emit: true }).expect(201)).body;
    const draft = (await api().post(`/fiscal/invoices/${original.id}/replace`).set(h).expect(200)).body;
    expect(draft.status).toBe('rascunho');
    expect(draft.replacesId).toBe(original.id);
    let sent = '';
    nock(SEFIN).post('/nfse', (b) => { sent = unpackXml(b.dpsXmlGZipB64); return true; }).reply(201, { chaveAcesso: CHAVE2, nfseXmlGZipB64: packXml(nfseXml(CHAVE2, '31')) });
    const body = { ...draftBody(customer.id, service.id), description: 'Descrição corrigida do treinamento', receivable: undefined, emit: true };
    const replaced = (await api().put(`/fiscal/invoices/${draft.id}`).set(h).send(body).expect(200)).body;
    expect(replaced.status).toBe('autorizada');
    expect(sent).toContain(`<subst><chSubstda>${CHAVE}</chSubstda><cMotivo>99</cMotivo>`);
    const old = (await api().get(`/fiscal/invoices/${original.id}`).set(h).expect(200)).body;
    expect(old.status).toBe('substituida');
    expect(old.replacedById).toBe(replaced.id);
    expect(replaced.receivables).toHaveLength(1);
    expect(old.receivables).toHaveLength(0);
  });

  it('nota emitida fora do sistema e permissões', async () => {
    const { company, customer, service, h } = await cenario();
    const ext = (await api().post('/fiscal/invoices/external').set(h).send({ ...draftBody(customer.id, service.id), number: '1234', issuedAt: '2026-11-20' }).expect(201)).body;
    expect(ext.status).toBe('autorizada');
    expect(ext.provider).toBe('externa');
    expect(ext.receivables[0].netValue).toBe(1500);
    await api().post('/fiscal/invoices').set(auth(company.id, ['view_nfse'])).send(draftBody(customer.id, service.id)).expect(403);
    await api().put('/fiscal/settings').set(auth(company.id, ['view_nfse', 'emitir_nfse'])).send({ dpsSeries: '901' }).expect(403);
  });
  it('IBS/CBS: ligado exige os códigos no serviço, sugere pela tabela oficial e a DPS leva o grupo', async () => {
    const { customer, service, h } = await cenario();
    await api().put('/fiscal/settings').set(h).send({ ibsCbsEnabled: true, rentalNfseFrom: '2027-01-01' }).expect(200);
    const settings = (await api().get('/fiscal/settings').set(h).expect(200)).body;
    expect(settings.pending.join(' ')).toMatch(/sem indicador da operação/);
    expect(String(settings.rentalNfseFrom).slice(0, 10)).toBe('2027-01-01');
    const blocked = (await api().post('/fiscal/invoices/preview').set(h).send(draftBody(customer.id, service.id)).expect(200)).body;
    expect(blocked.errors.join(' ')).toMatch(/indicador da operação e do cClassTrib/);

    const list = (await api().get('/fiscal/service-codes').set(h).expect(200)).body;
    expect(list[0].ibsCbsSuggestion).toMatchObject({ indOp: '030101', classTrib: '000001' });
    await api().put(`/fiscal/service-codes/${service.id}`).set(h).send({ ibsCbsIndOp: '999999' }).expect(400);
    await api().put(`/fiscal/service-codes/${service.id}`).set(h).send({ ibsCbsIndOp: '030101', ibsCbsClassTrib: '000001' }).expect(200);
    expect((await api().get('/fiscal/catalog/indop').set(h).expect(200)).body.length).toBeGreaterThan(20);

    let sent = '';
    nock(SEFIN).post('/nfse', (b) => { sent = unpackXml(b.dpsXmlGZipB64); return true; }).reply(201, { chaveAcesso: CHAVE, nfseXmlGZipB64: packXml(nfseXml(CHAVE, '40')) });
    const inv = (await api().post('/fiscal/invoices').set(h).send({ ...draftBody(customer.id, service.id), emit: true }).expect(201)).body;
    expect(inv.status).toBe('autorizada');
    expect(sent).toContain('<cIndOp>030101</cIndOp>');
    expect(sent).toContain('<CST>000</CST><cClassTrib>000001</cClassTrib>');
  });
});

