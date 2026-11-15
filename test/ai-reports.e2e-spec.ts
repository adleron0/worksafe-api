import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as nock from 'nock';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { FakeProvider } from 'src/features/ai/providers/fake.provider';
import { ReportService, nextRun } from 'src/features/ai/reports/report.service';
import { ToolCatalogService } from 'src/features/ai/tools/tool-catalog.service';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';

/** Relatórios agendados: de dados (sem IA) e de IA, entregues no sistema, por e-mail e WhatsApp. */
describe('Relatórios agendados (e2e)', () => {
  let jwt: JwtService;
  let reports: ReportService;
  let catalog: ToolCatalogService;
  let userId = 0;
  const PERMS = ['usar_bots', 'update_bots', 'list_classes', 'usar_bot_gestao'];

  beforeAll(async () => {
    process.env.AI_DEFAULT_PROVIDER = 'fake';
    process.env.AI_MODEL_FAST = 'fake';
    process.env.AI_MODEL_STRONG = 'fake';
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    reports = app.get(ReportService);
    catalog = app.get(ToolCatalogService);
    // nada sai para a internet nesta suíte
    nock.disableNetConnect();
    nock.enableNetConnect(/127\.0\.0\.1|localhost/);
  });
  afterAll(async () => { nock.enableNetConnect(); await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });
  afterEach(() => { nock.cleanAll(); for (const key of ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TEMPLATE']) delete process.env[key]; });

  const auth = (companyId: number, permissions: string[] = PERMS, sub = userId) => {
    const payload = { sub, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  const api = () => request(httpServer());

  /** O relatório usa as permissões do dono, lidas do banco. */
  async function grant(id: number, names: string[]) {
    const db = testDb();
    for (const name of names) {
      const permission = await db.permission.upsert({ where: { name }, create: { name }, update: {} });
      await db.userPermission.create({ data: { userId: id, permissionId: permission.id } });
    }
  }
  async function cenario() {
    const company = await makeCompany();
    userId = (await makeSeller(company.id, { name: 'Ana', phone: '(81) 98888-7777' })).id;
    await grant(userId, PERMS);
    const course = await makeCourse(company.id);
    await makeCourseClass(company.id, course.id, { name: 'NR-35 Semana', initialDate: new Date(Date.now() + 2 * 86400000), finalDate: new Date(Date.now() + 3 * 86400000), maxSubscriptions: 10, unlimitedSubscriptions: false });
    return { company, db: testDb() };
  }

  it('próxima execução no horário de Brasília', () => {
    const after = new Date('2026-11-16T12:00:00Z'); // segunda, 09:00 em Brasília
    expect(nextRun({ frequency: 'daily', time: '07:00', dayOfWeek: null, dayOfMonth: null }, after).toISOString()).toBe('2026-11-17T10:00:00.000Z');
    expect(nextRun({ frequency: 'daily', time: '10:30', dayOfWeek: null, dayOfMonth: null }, after).toISOString()).toBe('2026-11-16T13:30:00.000Z');
    expect(nextRun({ frequency: 'weekly', time: '08:00', dayOfWeek: 5, dayOfMonth: null }, after).toISOString()).toBe('2026-11-20T11:00:00.000Z');
    expect(nextRun({ frequency: 'monthly', time: '07:00', dayOfWeek: null, dayOfMonth: 1 }, after).toISOString()).toBe('2026-12-01T10:00:00.000Z');
  });

  it('relatório de dados: gera agora, entrega no sistema e por WhatsApp (API oficial)', async () => {
    const { company, db } = await cenario();
    process.env.WHATSAPP_TOKEN = 'tok';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
    process.env.WHATSAPP_TEMPLATE = 'relatorio_pronto';
    let sent: any = null;
    nock('https://graph.facebook.com').post('/v21.0/123/messages', (body) => { sent = body; return true; }).reply(200, { messages: [{ id: 'wamid' }] });

    const options = (await api().get('/ai/schedules').set(auth(company.id)).expect(200)).body;
    expect(options.channels).toEqual({ system: true, email: false, whatsapp: true });
    await api().post('/ai/schedules').set(auth(company.id)).send({ name: 'Agenda', kind: 'data', report: 'inexistente', frequency: 'daily' }).expect(400);
    const schedule = (await api().post('/ai/schedules').set(auth(company.id)).send({ name: 'Agenda do dia', kind: 'data', report: 'agenda_do_dia', frequency: 'daily', time: '07:00', channels: ['system', 'whatsapp'], recipients: [userId] }).expect(201)).body;
    expect(schedule.nextRunAt).toBeTruthy();

    const created = (await api().post(`/ai/schedules/${schedule.id}/run`).set(auth(company.id)).expect(200)).body;
    const report = (await api().get(`/ai/reports/${created.id}`).set(auth(company.id)).expect(200)).body;
    expect(report.title).toMatch(/^Agenda do dia — \d{2}\/\d{2}\/\d{4}$/);
    expect(report.body).toContain('## Turmas nos próximos 7 dias');
    expect(report.body).toContain('NR-35 Semana');
    // sem permissão de OS e comercial, o relatório diz isso em vez de vazar
    expect(report.body).toContain('Sem permissão para ver as OS');
    expect(report.deliveries).toEqual([{ channel: 'system', userId, status: 'enviado' }, { channel: 'whatsapp', userId, status: 'enviado' }]);
    expect(sent).toMatchObject({ to: '5581988887777', type: 'template', template: { name: 'relatorio_pronto', language: { code: 'pt_BR' } } });
    expect(sent.template.components[0].parameters[1].text).toContain(`/bots/relatorios/${created.id}`);
    // as consultas ficaram na auditoria como agendamento
    expect(await db.ai_ToolCall.count({ where: { origin: 'schedule', status: 'ok' } })).toBeGreaterThan(0);

    // outra pessoa que não recebe não vê
    const other = await makeSeller(company.id);
    await api().get(`/ai/reports/${created.id}`).set(auth(company.id, ['usar_bots'], other.id)).expect(404);
  });

  it('o agendador roda só o que venceu, uma vez, e relatório de IA usa o bot', async () => {
    const { company, db } = await cenario();
    const bots = (await api().get('/ai/bots').set(auth(company.id)).expect(200)).body;
    const gestao = bots.find((bot: any) => bot.key === 'gestao');
    const schedule = (await api().post('/ai/schedules').set(auth(company.id)).send({ name: 'Resumo IA', kind: 'ai', botId: gestao.id, prompt: 'Faça o resumo da semana das turmas.', frequency: 'weekly', dayOfWeek: 1, time: '08:00', channels: ['system', 'email'], recipients: [userId] }).expect(201)).body;
    expect(await reports.runDue()).toBe(0); // ainda não venceu

    await db.ai_Schedule.update({ where: { id: schedule.id }, data: { nextRunAt: new Date(Date.now() - 60000) } });
    FakeProvider.script([() => ({ toolCalls: [{ name: 'listar_turmas', input: {} }] }), () => ({ text: '## Resumo\nUma turma na semana.' })]);
    expect(await reports.runDue()).toBe(1);
    expect(await reports.runDue()).toBe(0); // não roda de novo
    const [report] = await db.ai_Report.findMany({ where: { scheduleId: schedule.id } });
    expect(report.body).toBe('## Resumo\nUma turma na semana.');
    // e-mail não configurado na suíte: falha registrada, sem derrubar o resto
    expect(report.deliveries).toEqual([{ channel: 'system', userId, status: 'enviado' }, expect.objectContaining({ channel: 'email', status: 'falhou' })]);
    const updated = await db.ai_Schedule.findUnique({ where: { id: schedule.id } });
    expect(updated!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    // a conversa do agendamento não aparece na lista de conversas do bot
    expect((await api().get(`/ai/bots/${gestao.id}/conversations`).set(auth(company.id)).expect(200)).body).toHaveLength(0);
  });

  it('agenda: uma vez, a cada X horas e vários dias da semana', () => {
    const after = new Date('2026-11-16T12:00:00Z'); // segunda, 09:00 em Brasília
    const base = { time: '07:00', dayOfWeek: null, dayOfMonth: null };
    expect(nextRun({ ...base, frequency: 'once', runAt: new Date('2026-11-17T15:00:00Z') }, after)!.toISOString()).toBe('2026-11-17T15:00:00.000Z');
    expect(nextRun({ ...base, frequency: 'once', runAt: new Date('2026-11-15T15:00:00Z') }, after)).toBeNull();
    // a cada 3 h das 8h às 18h: 08, 11, 14, 17 → depois das 09:00 vem 11:00
    expect(nextRun({ ...base, frequency: 'hourly', everyHours: 3 }, after)!.toISOString()).toBe('2026-11-16T14:00:00.000Z');
    // sexta 20:00 → segunda 08:00 (pula o fim de semana)
    expect(nextRun({ ...base, frequency: 'hourly', everyHours: 2 }, new Date('2026-11-20T23:00:00Z'))!.toISOString()).toBe('2026-11-23T11:00:00.000Z');
    expect(nextRun({ ...base, frequency: 'weekly', daysOfWeek: [3, 5], time: '08:00' }, after)!.toISOString()).toBe('2026-11-18T11:00:00.000Z');
  });

  it('gatilho por evento: dispara com o contexto, uma vez só, e respeita o limite do dia', async () => {
    const { company, db } = await cenario();
    await grant(userId, ['usar_bot_financeiro', 'list_financeiro']);
    const bots = (await api().get('/ai/bots').set(auth(company.id, [...PERMS, 'usar_bot_financeiro'])).expect(200)).body;
    const otavio = bots.find((bot: any) => bot.key === 'financeiro');
    const task = (await api().post('/ai/schedules').set(auth(company.id, [...PERMS, 'usar_bot_financeiro'])).send({
      name: 'Categorizar despesas novas', kind: 'ai', botId: otavio.id, prompt: 'Categorize a despesa que entrou sem categoria.', frequency: 'event', eventType: 'despesa_sem_categoria', maxRunsPerDay: 1,
    }).expect(201)).body;
    expect(task).toMatchObject({ frequency: 'event', eventLabel: 'Despesa sem categoria', active: true });

    expect(await reports.runDue(new Date(Date.now() + 61000))).toBe(0); // nada aconteceu ainda
    await db.financial_Payable.create({ data: { companyId: company.id, description: 'Conta de luz', value: 480, dueDate: new Date('2026-12-10T12:00:00Z'), accrualDate: '2026-12', status: 'aberta', origin: 'manual' } });
    FakeProvider.script([(req) => ({ text: req.messages.some((m: any) => m.role === 'user' && m.text.includes('Conta de luz')) ? 'Categorizei a conta de luz.' : 'sem contexto' })]);
    await db.ai_Schedule.update({ where: { id: task.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    expect(await reports.runDue(new Date(Date.now() + 2000))).toBe(1);
    const [report] = await db.ai_Report.findMany({ where: { scheduleId: task.id } });
    expect(report.body).toBe('Categorizei a conta de luz.');
    // a mesma despesa não dispara de novo
    await db.ai_Schedule.update({ where: { id: task.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    expect(await reports.runDue(new Date(Date.now() + 2000))).toBe(0);
    // outra despesa, mas o limite do dia (1) já foi
    await db.financial_Payable.create({ data: { companyId: company.id, description: 'Água', value: 90, dueDate: new Date('2026-12-12T12:00:00Z'), accrualDate: '2026-12', status: 'aberta', origin: 'manual' } });
    await db.ai_Schedule.update({ where: { id: task.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    expect(await reports.runDue(new Date(Date.now() + 2000))).toBe(0);
    expect(await db.ai_Report.count({ where: { scheduleId: task.id } })).toBe(1);
  });

  it('cada um agenda para si; criar pela conversa passa pelo cartão; 3 falhas pausam', async () => {
    const { company, db } = await cenario();
    const comum = (await makeSeller(company.id, { name: 'Bia' })).id;
    await grant(comum, ['usar_bots', 'usar_bot_gestao']);
    const BIA = ['usar_bots', 'usar_bot_gestao'];
    const asBia = (perms = BIA) => auth(company.id, perms, comum);
    const gestao = (await api().get('/ai/bots').set(asBia()).expect(200)).body.find((bot: any) => bot.key === 'gestao');
    // tarefa de outra pessoa (a Ana) não aparece para a Bia
    await api().post('/ai/schedules').set(auth(company.id)).send({ name: 'Agenda da Ana', kind: 'data', report: 'agenda_do_dia', frequency: 'daily' }).expect(201);
    const mine = (await api().post('/ai/schedules').set(asBia()).send({ name: 'Resumo da Bia', kind: 'ai', botId: gestao.id, prompt: 'Resumo do dia para a Bia.', frequency: 'daily', recipients: [userId] }).expect(201)).body;
    expect(mine.recipients).toEqual([comum]); // não manda para outra pessoa
    const list = (await api().get('/ai/schedules').set(asBia()).expect(200)).body;
    expect(list.schedules.map((row: any) => row.name)).toEqual(['Resumo da Bia']);
    expect(list.events.length).toBeGreaterThan(5);
    await api().put(`/ai/schedules/${list.schedules[0].id - 1}`).set(asBia()).send({ name: 'Invasão' }).expect(404);

    // pela conversa: prepara, confirma e a tarefa nasce da Bia
    const ctx = { userId: comum, companyId: company.id, permissions: BIA, origin: 'bots' as const, botId: gestao.id };
    const out = await catalog.call(ctx, 'agendar_tarefa', { nome: 'Funil toda segunda', oQueFazer: 'Mande o funil comercial da semana.', quando: 'semanal', diasDaSemana: [1], hora: '08:00' }, null);
    expect(out.status).toBe('pending');
    expect(JSON.parse(out.content).resumo).toContain('Helena');
    await api().post(`/ai/actions/${out.pendingActionId}/confirm`).set(asBia()).expect(200);
    const created = await db.ai_Schedule.findFirstOrThrow({ where: { name: 'Funil toda segunda' } });
    expect(created).toMatchObject({ ownerUserId: comum, frequency: 'weekly', time: '08:00', botId: gestao.id, active: true });
    expect(created.nextRunAt).not.toBeNull();
    const listed = JSON.parse((await catalog.call(ctx, 'minhas_tarefas', {}, null)).content);
    expect(listed.tarefas.map((row: any) => row.nome).sort()).toEqual(['Funil toda segunda', 'Resumo da Bia']);
    expect(JSON.parse((await catalog.call(ctx, 'pausar_tarefa', { id: created.id, pausar: true }, null)).content)).toMatchObject({ ativa: false });

    // a Bia perde o acesso ao bot: a tarefa falha e, na terceira, pausa sozinha
    await db.userPermission.updateMany({ where: { userId: comum, permission: { name: 'usar_bot_gestao' } }, data: { inactiveAt: new Date() } });
    for (let i = 0; i < 3; i++) await api().post(`/ai/schedules/${mine.id}/run`).set(asBia()).expect(200);
    expect(await db.ai_Schedule.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ active: false, failures: 3, lastStatus: 'falhou', pausedReason: expect.stringContaining('3 falhas') });
  });
});
