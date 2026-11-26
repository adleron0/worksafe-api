import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as nock from 'nock';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { makeTestPfx } from 'src/features/fiscal/test-certificate';
import { ADN_URLS, packXml } from 'src/features/fiscal/sefin.client';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Notas recebidas (distribuição do ADN por NSU, simulada com nock): baixa só o
 * que a empresa tomou, reconhece o fornecedor pelo CNPJ, lança conta a pagar
 * com o líquido, ignora e monta o pacote do contador.
 */
process.env.FISCAL_SECRET = 'chave-fiscal-de-teste-com-32-chars!!';

describe('Área fiscal — notas recebidas e pacote do contador (e2e)', () => {
  const PERMS = ['view_nfse', 'emitir_nfse', 'config_fiscal', 'list_financeiro', 'create_financeiro'];
  const ADN = ADN_URLS.restrita;
  const CNPJ = '12345678000195';
  const FORN = '11222333000181';
  const K1 = '26116062112223330001810000000000000526110000000005';
  const K2 = '26116062112223330001810000000000000626110000000006';
  const KOWN = '26116062123456780001950000000000000926110000000009';
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => { blockRealNetwork(); jwt = (await bootTestApp()).get(JwtService); });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); nock.cleanAll(); });
  beforeEach(async () => { await resetDb(); await flushCache(); nock.cleanAll(); });

  const auth = (companyId: number, permissions: string[] = PERMS) => ({
    Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}`,
  });
  const api = () => request(httpServer());

  const xml = (key: string, n: string, issuer: string, issuerName: string, taker: string, extra = '') =>
    `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${key}"><nNFSe>${n}</nNFSe><cStat>100</cStat><dhProc>2026-11-10T10:00:00-03:00</dhProc>` +
    `<emit><CNPJ>${issuer}</CNPJ><xNome>${issuerName}</xNome></emit><valores><vISSQN>50.00</vISSQN><vLiq>${extra ? '940.00' : '1000.00'}</vLiq></valores>` +
    `<DPS><infDPS><dCompet>2026-11-05</dCompet><toma><CNPJ>${taker}</CNPJ><xNome>Tomador</xNome></toma><serv><cServ><xDescServ>Manutenção de EPI</xDescServ></cServ></serv>` +
    `<valores><vServPrest><vServ>1000.00</vServ></vServPrest><trib>${extra}</trib></valores></infDPS></DPS></infNFSe></NFSe>`;

  async function cenario() {
    const db = testDb();
    const state = await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } });
    const city = await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } });
    const company = await makeCompany({ cnpj: CNPJ, stateId: state.id, cityId: city.id, address: 'Rua da Aurora', addressNumber: '100', neighborhood: 'Boa Vista' });
    userId = (await makeSeller(company.id)).id;
    const h = auth(company.id);
    await api().put('/fiscal/settings').set(h).send({ simplesNacional: 3, simplesRegime: 1, simplesTotalRate: 6 }).expect(200);
    await api().post('/fiscal/settings/certificate').set(h).field('password', 'teste123').attach('file', makeTestPfx(CNPJ), 'empresa.pfx').expect(200);
    return { company, h };
  }

  it('baixa as recebidas, ignora as próprias, reconhece o fornecedor e não duplica', async () => {
    const { company, h } = await cenario();
    const supplier = await testDb().financial_Supplier.create({ data: { companyId: company.id, name: 'EPI Center', document: FORN } });
    nock(ADN).get('/DFe/0').query({ lote: 'true' }).reply(200, {
      StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS',
      LoteDFe: [
        { NSU: 1, ChaveAcesso: K1, TipoDocumento: 'NFSE', ArquivoXml: packXml(xml(K1, '5', FORN, 'EPI Center Ltda', CNPJ, '<tribFed><vRetIRRF>15.00</vRetIRRF><vRetCSLL>10.00</vRetCSLL></tribFed><tribMun><tpRetISSQN>2</tpRetISSQN></tribMun>')) },
        { NSU: 2, ChaveAcesso: KOWN, TipoDocumento: 'NFSE', ArquivoXml: packXml(xml(KOWN, '9', CNPJ, 'Nós mesmos', FORN)) },
        { NSU: 3, ChaveAcesso: K2, TipoDocumento: 'NFSE', ArquivoXml: packXml(xml(K2, '6', '99888777000166', 'Oficina Nova', CNPJ)) },
      ],
    });
    nock(ADN).get('/DFe/3').query({ lote: 'true' }).reply(404, { StatusProcessamento: 'NENHUM_DOCUMENTO_LOCALIZADO', Erros: [{ Codigo: 'E2220', Descricao: 'Nenhum documento localizado' }] });
    const sync = (await api().post('/fiscal/received/sync').set(h).expect(200)).body;
    expect(sync).toMatchObject({ created: 2, seen: 3, lastNsu: 3 });

    const list = (await api().get('/fiscal/received').set(h).expect(200)).body;
    expect(list.data).toHaveLength(2);
    expect(list.byStatus.nova).toBe(2);
    expect(list.syncedAt).toBeTruthy();
    const epi = list.data.find((r: any) => r.accessKey === K1);
    expect(epi).toMatchObject({ number: '5', issuerName: 'EPI Center Ltda', grossValue: 1000, netValue: 940, issWithheld: true, supplierId: supplier.id });
    expect(epi.retentions).toMatchObject({ ir: 15, csll: 10 });
    const x = await api().get(`/fiscal/received/${epi.id}/xml`).set(h).expect(200);
    expect(String(x.text ?? x.body)).toContain(K1);

    // segunda busca começa do último NSU e não duplica
    nock(ADN).get('/DFe/3').query({ lote: 'true' }).reply(404, {});
    expect((await api().post('/fiscal/received/sync').set(h).expect(200)).body).toMatchObject({ created: 0, lastNsu: 3 });
  });

  it('lança conta a pagar (fornecedor novo pelo CNPJ), ignora e monta o pacote do contador', async () => {
    const { company, h } = await cenario();
    nock(ADN).get('/DFe/0').query({ lote: 'true' }).reply(200, { LoteDFe: [
      { NSU: 7, ChaveAcesso: K2, TipoDocumento: 'NFSE', ArquivoXml: packXml(xml(K2, '6', '99888777000166', 'Oficina Nova', CNPJ)) },
      { NSU: 8, ChaveAcesso: K1, TipoDocumento: 'NFSE', ArquivoXml: packXml(xml(K1, '5', FORN, 'EPI Center Ltda', CNPJ)) },
    ] });
    nock(ADN).get('/DFe/8').query({ lote: 'true' }).reply(404, {});
    await api().post('/fiscal/received/sync').set(h).expect(200);
    const rows = (await api().get('/fiscal/received').set(h).expect(200)).body.data;
    const oficina = rows.find((r: any) => r.accessKey === K2);
    const epi = rows.find((r: any) => r.accessKey === K1);

    // sem permissão de lançar no financeiro
    await api().post(`/fiscal/received/${oficina.id}/payable`).set(auth(company.id, ['view_nfse'])).send({ dueDate: '2026-12-10' }).expect(403);
    await api().post(`/fiscal/received/${oficina.id}/payable`).set(h).send({}).expect(400);
    const done = (await api().post(`/fiscal/received/${oficina.id}/payable`).set(h).send({ dueDate: '2026-12-10' }).expect(200)).body;
    const payable = await testDb().financial_Payable.findUnique({ where: { id: done.payableId }, include: { supplier: true } });
    expect(Number(payable!.value)).toBe(1000);
    expect(payable!.documentNumber).toBe('6');
    expect(payable!.accrualDate).toBe('2026-11');
    expect(payable!.origin).toBe('nfse');
    expect(payable!.supplier?.document).toBe('99888777000166');
    await api().post(`/fiscal/received/${oficina.id}/payable`).set(h).send({ dueDate: '2026-12-10' }).expect(409);
    await api().post(`/fiscal/received/${oficina.id}/ignore`).set(h).expect(409);

    await api().post(`/fiscal/received/${epi.id}/ignore`).set(h).expect(200);
    expect((await api().get('/fiscal/received?status=ignorada').set(h).expect(200)).body.data).toHaveLength(1);
    await api().post(`/fiscal/received/${epi.id}/ignore`).set(h).send({ undo: true }).expect(200);

    await api().get('/fiscal/export?month=2026-13').set(h).expect(400);
    const zip = await api().get('/fiscal/export?month=2026-11').set(h).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(zip.headers['content-type']).toContain('application/zip');
    const text = (zip.body as Buffer).toString('latin1');
    expect(text.startsWith('PK')).toBe(true);
    expect(text).toContain('recebidas/Oficina Nova NFS-e 6.xml');
    expect(text).toContain('resumo-2026-11.xlsx');
  });
});
