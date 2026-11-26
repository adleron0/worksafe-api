import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as nock from 'nock';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { ToolCatalogService } from 'src/features/ai/tools/tool-catalog.service';
import { ToolContext } from 'src/features/ai/tools/tool.types';
import { makeTestPfx } from 'src/features/fiscal/test-certificate';
import { packXml, SEFIN_URLS } from 'src/features/fiscal/sefin.client';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Área fiscal, fase I6: ferramentas de nota fiscal para os bots e o MCP.
 * Consultar e simular rodam direto; emitir, cancelar e reenviar só preparam o
 * cartão, e a nota só sai quando a pessoa confirma.
 */
process.env.FISCAL_SECRET = 'chave-fiscal-de-teste-com-32-chars!!';

describe('Ferramentas de NFS-e (bots e MCP) (e2e)', () => {
  const ALL = ['usar_mcp', 'view_nfse', 'emitir_nfse', 'cancelar_nfse', 'config_fiscal', 'list_financeiro'];
  const SEFIN = SEFIN_URLS.restrita;
  const CHAVE = '26116062123456780001950000000000000126110000000001';
  let jwt: JwtService;
  let catalog: ToolCatalogService;
  let userId = 0;

  beforeAll(async () => { blockRealNetwork(); const app = await bootTestApp(); jwt = app.get(JwtService); catalog = app.get(ToolCatalogService); });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); nock.cleanAll(); });
  beforeEach(async () => { await resetDb(); await flushCache(); nock.cleanAll(); });

  const auth = (companyId: number, permissions: string[] = ALL) => ({ Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` });
  const api = () => request(httpServer());

  async function cenario(permissions = ALL) {
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
    const service = (await api().post('/fiscal/service-codes').set(h).send({ name: 'Treinamento', nationalCode: '080201', issRate: 5, description: 'Treinamento para {cliente}.', isDefault: true }).expect(201)).body;
    const course = await makeCourse(company.id);
    const klass = await makeCourseClass(company.id, course.id, { name: 'Turma 12' });
    const sub = await db.courseClassSubscription.create({ data: { name: 'João da Silva', cpf: '52998224725', email: 'joao@aluno.local', phone: '81999990000', classId: klass.id, companyId: company.id, subscribeStatus: 'confirmed' } });
    await db.financialRecords.create({ data: { companyId: company.id, gateway: 'manual', status: 'received', paymentMethod: 'pix', value: 500, paidAt: new Date(), accrualDate: '2026-11', subscriptionId: sub.id } });
    const ctx: ToolContext = { userId, companyId: company.id, permissions, origin: 'mcp' };
    const call = async (tool: string, input: Record<string, unknown> = {}) => {
      const out = await catalog.call(ctx, tool, input, null);
      return { ...out, data: JSON.parse(out.content) };
    };
    return { company, customer, service, sub, h, call };
  }

  it('consulta, simula e prepara a emissão; a nota só sai ao confirmar o cartão', async () => {
    const { company, customer, service, sub, call } = await cenario();
    // o MCP enxerga as ferramentas de nota (as de ação marcadas como "só prepara")
    const names = catalog.visible(null, ALL).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['notas_fiscais', 'ver_nota_fiscal', 'notas_a_emitir', 'simular_nota_fiscal', 'rascunho_nota_fiscal', 'emitir_nota_fiscal', 'cancelar_nota_fiscal', 'reenviar_nota_fiscal']));

    const pending = await call('notas_a_emitir');
    expect(pending.status).toBe('ok');
    expect(pending.data.inscricoesPagasSemNota).toEqual([expect.objectContaining({ inscricaoId: sub.id, aluno: 'João da Silva', valor: 500 })]);

    const sim = await call('simular_nota_fiscal', { origem: 'avulsa', clienteId: customer.id, servicoFiscalId: service.id, valor: 2000, issRetido: true, retencoes: { ir: 1.5 } });
    expect(sim.data.podeEmitir).toBe(true);
    expect(sim.data.resumo).toEqual(expect.arrayContaining([{ label: 'Líquido', value: expect.stringContaining('1.870') }]));

    // emitir: só prepara (cartão), nada vai para a Sefin antes da confirmação
    const card = await call('emitir_nota_fiscal', { origem: 'inscricoes', inscricaoIds: [sub.id] });
    expect(card.status).toBe('pending');
    expect(card.data.resumo).toContain('Emitir a NFS-e de João da Silva');
    expect(await testDb().fiscal_Invoice.count()).toBe(0);
    nock(SEFIN).post('/nfse').reply(201, { chaveAcesso: CHAVE, nfseXmlGZipB64: packXml(`<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${CHAVE}"><nNFSe>77</nNFSe><cStat>100</cStat><dhProc>2026-11-25T12:00:01-03:00</dhProc><valores><vLiq>500.00</vLiq></valores><DPS/></infNFSe></NFSe>`) });
    const confirmed = (await api().post(`/ai/actions/${card.pendingActionId}/confirm`).set(auth(company.id)).expect(200)).body;
    expect(confirmed.result.message).toContain('nº 77 autorizada');
    const inv = await testDb().fiscal_Invoice.findFirstOrThrow({ where: { companyId: company.id } });
    expect(inv.status).toBe('autorizada');

    const list = await call('notas_fiscais');
    expect(list.data.notas).toEqual([expect.objectContaining({ numero: '77', situacao: 'autorizada', tomador: 'João da Silva' })]);
    const view = await call('ver_nota_fiscal', { id: inv.id });
    expect(view.data.chave).toBe(CHAVE);

    // cancelar também só prepara; motivo curto é recusado
    expect((await call('cancelar_nota_fiscal', { id: inv.id, motivo: 'curto' })).status).toBe('refused');
    const cancel = await call('cancelar_nota_fiscal', { id: inv.id, motivo: 'Nome do aluno digitado errado', codigo: '1' });
    expect(cancel.status).toBe('pending');
    expect(JSON.stringify(cancel.data)).toContain('pagamento da inscrição continua');
    nock(SEFIN).post(`/nfse/${CHAVE}/eventos`).reply(201, { eventoXmlGZipB64: packXml('<evento><cStat>135</cStat></evento>') });
    await api().post(`/ai/actions/${cancel.pendingActionId}/confirm`).set(auth(company.id)).expect(200);
    expect((await testDb().fiscal_Invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('cancelada');
  });

  it('erro de cadastro aparece antes do cartão; sem permissão a ferramenta some', async () => {
    const { customer, call } = await cenario();
    const refused = await call('emitir_nota_fiscal', { origem: 'avulsa', clienteId: customer.id, valor: 0 });
    expect(refused.status).toBe('refused');
    const draft = await call('rascunho_nota_fiscal', { origem: 'avulsa', clienteId: customer.id, valor: 300 });
    expect(draft.data.situacao).toBe('rascunho');
    const card = await call('emitir_nota_fiscal', { rascunhoId: draft.data.id });
    expect(card.status).toBe('pending');
    const viewer = catalog.visible(null, ['usar_mcp', 'view_nfse']).map((t) => t.name);
    expect(viewer).toContain('notas_fiscais');
    expect(viewer).not.toContain('emitir_nota_fiscal');
    expect(viewer).not.toContain('cancelar_nota_fiscal');
  });
});
