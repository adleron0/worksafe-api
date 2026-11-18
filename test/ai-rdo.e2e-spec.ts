import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';
import { ToolCatalogService } from 'src/features/ai/tools/tool-catalog.service';
import { ToolContext } from 'src/features/ai/tools/tool.types';
import { NotifyService } from 'src/features/ai/reports/notify.service';

/**
 * Bruno e o diário de obra: lê e confere os RDOs (pontos de atenção calculados
 * pelo sistema), vê o que falta, devolve para quem preencheu corrigir (aparece
 * na esteira da pessoa até fechar de novo) e cobra por e-mail, com confirmação.
 */
describe('Bots — diário de obra (RDO) (e2e)', () => {
  const COMMERCIAL = ['list_comercial', 'create_comercial', 'update_comercial', 'all_propostas', 'update_acompanhamento'];
  const ORDERS = ['list_ordens_de_servico', 'update_ordens_de_servico', 'all_ordens_de_servico', 'update_rdo'];
  const ALL = [...COMMERCIAL, ...ORDERS, 'view_custos_comercial', 'list_financeiro', 'create_financeiro', 'usar_mcp'];
  const YEAR = new Date().getFullYear();
  const TODAY = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const day = (offset: number) => new Date(new Date(`${TODAY}T12:00:00Z`).getTime() + offset * 86400000).toISOString().slice(0, 10);
  let jwt: JwtService;
  let catalog: ToolCatalogService;
  let notify: NotifyService;
  let userId = 0;
  let cnpj = 0;

  beforeAll(async () => {
    blockRealNetwork();
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    catalog = app.get(ToolCatalogService);
    notify = app.get(NotifyService);
  });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  afterEach(() => jest.restoreAllMocks());
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

  /** Proposta de serviço enviada, com uma parcela para o fim da obra. */
  async function cenario() {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const customer = await makeCustomer(company.id);
    const h = auth(company.id);
    const options = (await api().get('/commercial/proposals/options').set(h).expect(200)).body;
    const professionalId = options.professionals.find((p: any) => p.name === 'Alpinista N1').id;
    const proposal = (await api().post('/commercial/proposals').set(h).send({
      kind: 'servico', customerId: customer.id, title: 'Jateamento de estrutura', description: 'Jato e pintura do tanque 3', contactName: 'Maria Souza', workDays: 22, contingencyRate: 0.05,
      sections: [
        { title: 'Mão de obra', kind: 'mao_de_obra', margin: 0.26, items: [{ type: 'mao_de_obra', professionalId, quantity: 2 }] },
        { title: 'Locações', kind: 'locacao', margin: 0.05, items: [{ type: 'locacao', description: 'Andaime tubular', quantity: 1, unitCost: 1500 }] },
      ],
      installments: [
        { percent: 0.5, dueRule: 'dias_apos_aceite', dueDays: 5, description: 'Entrada' },
        { percent: 0.5, dueRule: 'dias_apos_conclusao', dueDays: 10, description: 'Fim da obra' },
      ],
      schedule: { unit: 'dia', steps: [{ title: 'Mobilização', start: 1, duration: 2 }, { title: 'Execução', start: 3, duration: 20 }] },
    }).expect(201)).body;
    await api().patch(`/commercial/proposals/status/${proposal.id}`).set(h).send({ status: 'enviada' }).expect(200);
    return { company, customer, h, proposal };
  }
  const aceitar = async (h: Record<string, string>, proposalId: number, extra: Record<string, unknown> = {}) =>
    (await api().patch(`/commercial/proposals/status/${proposalId}`).set(h).send({ status: 'aceita', ...extra }).expect(200)).body;
  const listar = async (h: Record<string, string>, query: Record<string, unknown> = {}) => (await api().get('/service-orders').query(query).set(h).expect(200)).body;
  const mover = (h: Record<string, string>, id: number, body: Record<string, unknown>) => api().patch(`/service-orders/${id}/status`).set(h).send(body);

  const rdo = (h: Record<string, string>, orderId: number, body: Record<string, unknown>) => api().post(`/service-orders/${orderId}/reports`).set(h).send(body);
  const fechar = (h: Record<string, string>, id: number) => api().patch(`/service-reports/${id}/close`).set(h);
  async function emExecucao() {
    const { h, proposal, company } = await cenario();
    const id = (await aceitar(h, proposal.id, { customerOrderNumber: '1' })).contract.serviceOrder.id as number;
    await mover(h, id, { status: 'agendada', plannedStart: day(-3) }).expect(200);
    await mover(h, id, { status: 'em_execucao', date: day(-3) }).expect(200);
    return { h, id, company };
  }
  const joao = { name: 'João', role: 'Alpinista N1', hours: 8, overtime: 0 };
  const call = (ctx: ToolContext) => async (tool: string, input: Record<string, unknown> = {}) => {
    const out = await catalog.call(ctx, tool, input, null);
    return { ...out, data: out.content ? JSON.parse(out.content) : null };
  };
  const isSunday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() === 0;

  it('lê, confere, mostra o que falta, devolve com o motivo e cobra por e-mail', async () => {
    const { h, id, company } = await emExecucao();
    const db = testDb();
    await db.service_Order.update({ where: { id }, data: { responsibleUserId: userId } });
    const bruno = call({ userId, companyId: company.id, permissions: ALL, origin: 'mcp' });

    // ontem-1: fechado, mas sem fotos e com descrição curta; ontem: rascunho esquecido
    const fechado = (await rdo(h, id, { date: day(-2), startTime: '07:30', endTime: '17:00', crew: [{ ...joao, hours: 9, overtime: 5 }], activities: 'Jato' }).expect(201)).body;
    await fechar(h, fechado.id).expect(200);
    const rascunho = (await rdo(h, id, { date: day(-1), startTime: '07:30', crew: [joao], activities: 'Pintura do costado norte, primeira demão completa' }).expect(201)).body;

    const ver = await bruno('ver_rdo', { rdoId: fechado.id });
    expect(ver.status).toBe('ok');
    expect(ver.data).toMatchObject({ situacao: 'fechado', entrada: '07:30', saida: '17:00' });
    expect(ver.data.pontosDeAtencao).toEqual(expect.arrayContaining(['Sem fotos.', 'A descrição do que foi feito está curta demais para acompanhar a obra.', 'João está com 14 h no dia (acima de 12 h).']));

    const andamento = await bruno('listar_rdos', { osId: id });
    expect(andamento.data.andamento).toMatchObject({ rdos: 2, rascunhos: 1 });
    expect(andamento.data.rdos.map((row: any) => row.id)).toEqual([rascunho.id, fechado.id]);

    const pendentes = await bruno('rdos_pendentes', { dias: 7 });
    const obra = pendentes.data.pendencias.find((row: any) => row.id === id);
    expect(obra.rascunhosAbertos).toEqual([expect.objectContaining({ id: rascunho.id })]);
    const br = (date: string) => date.split('-').reverse().join('/');
    if (!isSunday(day(-3))) expect(obra.diasSemRdo).toContain(br(day(-3)));
    expect(obra.diasSemRdo).not.toContain(br(day(-2)));

    // devolver: pede confirmação; volta a rascunho com o motivo e aparece na esteira de quem preencheu
    const emails: string[] = [];
    jest.spyOn(notify, 'emailReady').mockReturnValue(true);
    jest.spyOn(notify, 'sendEmail').mockImplementation(async (to: string) => { emails.push(to); });
    const curto = await bruno('devolver_rdo', { rdoId: fechado.id, motivo: 'foto' });
    expect(curto.status).toBe('refused');
    const devolver = await bruno('devolver_rdo', { rdoId: fechado.id, motivo: 'Inclua as fotos do dia e descreva o que foi jateado' });
    expect(devolver.status).toBe('pending');
    expect((await db.service_DailyReport.findUnique({ where: { id: fechado.id } }))!.status).toBe('fechado');
    const done = (await api().post(`/ai/actions/${devolver.pendingActionId}/confirm`).set(auth(company.id)).expect(200)).body;
    expect(done.result.message).toContain('devolvido para correção');
    expect(emails).toHaveLength(1);
    const devolvido = await db.service_DailyReport.findUnique({ where: { id: fechado.id } });
    expect(devolvido).toMatchObject({ status: 'rascunho', returnNote: 'Inclua as fotos do dia e descreva o que foi jateado', returnedByUserId: userId });
    expect((await db.flow_Event.findFirst({ where: { entity: 'service_report', entityId: fechado.id, type: 'devolvido' } }))!.note).toContain('fotos');
    const tela = (await api().get(`/service-reports/${fechado.id}`).set(h).expect(200)).body;
    expect(tela.returned).toMatchObject({ note: 'Inclua as fotos do dia e descreva o que foi jateado', by: 'Vendedor Teste' });
    const esteira = (await api().get('/my-pipeline').set(h).expect(200)).body;
    const blocos = esteira.blocks ?? esteira;
    expect(blocos.find((block: any) => block.key === 'rdo_devolvido')).toMatchObject({ count: 1 });
    expect((await bruno('listar_rdos', { situacao: 'devolvido' })).data.rdos.map((row: any) => row.id)).toEqual([fechado.id]);

    // corrigido e fechado de novo: a devolução some
    await api().put(`/service-reports/${fechado.id}`).set(h).send({ startTime: '07:30', endTime: '17:00', crew: [joao], activities: 'Jato do costado sul', photos: [{ url: 'https://x.local/a.jpg', caption: 'Costado' }] }).expect(200);
    await fechar(h, fechado.id).expect(200);
    expect(await db.service_DailyReport.findUnique({ where: { id: fechado.id } })).toMatchObject({ returnNote: null, returnedAt: null });

    // cobrar: confirma e manda um e-mail para o responsável com as pendências
    const cobrar = await bruno('cobrar_rdo', { osId: id, mensagem: 'Preciso disso até amanhã.' });
    expect(cobrar.status).toBe('pending');
    expect(cobrar.data.resumo ?? cobrar.content).toContain('Cobrar por e-mail');
    await api().post(`/ai/actions/${cobrar.pendingActionId}/confirm`).set(auth(company.id)).expect(200);
    expect(emails).toHaveLength(2);
    const [, , , body] = (notify.sendEmail as jest.Mock).mock.calls[1];
    expect(body).toContain(`Rascunhos não fechados: ${br(day(-1))}`);
    expect(body).toContain('Preciso disso até amanhã.');
  });

  it('devolver e cobrar pedem a permissão de alterar a OS; sem e-mail configurado não cobra', async () => {
    const { id, company } = await emExecucao();
    const encarregado = call({ userId, companyId: company.id, permissions: ['usar_mcp', 'list_ordens_de_servico', 'update_rdo', 'all_ordens_de_servico'], origin: 'mcp' });
    expect((await encarregado('devolver_rdo', { rdoId: 1, motivo: 'Faltam as fotos do dia' })).status).toBe('denied');
    expect((await encarregado('cobrar_rdo', { osId: id })).status).toBe('denied');
    jest.spyOn(notify, 'emailReady').mockReturnValue(false);
    const coordenador = call({ userId, companyId: company.id, permissions: ALL, origin: 'mcp' });
    const semEmail = await coordenador('cobrar_rdo', { osId: id });
    expect(semEmail.status).toBe('refused');
    expect(semEmail.content).toContain('não está configurado');
  });
});
