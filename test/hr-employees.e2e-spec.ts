import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Funcionários (RH): cadastro com funções, dados pessoais só com permissão,
 * histórico (férias, afastamento, suspensão, advertência, desligamento) e a
 * situação calculada a partir dele.
 */
describe('Funcionários (e2e)', () => {
  const BASE = ['list_funcionarios', 'view_funcionarios', 'create_funcionarios', 'update_funcionarios', 'inactive_funcionarios', 'activate_funcionarios'];
  const RH = [...BASE, 'view_dados_pessoais_funcionarios', 'view_ocorrencias_funcionarios', 'update_ocorrencias_funcionarios'];
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => {
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });

  const auth = (companyId: number, permissions: string[] = RH) => {
    const payload = { sub: userId, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  const api = () => request(httpServer());
  const day = (offset: number) => new Date(Date.now() - 3 * 3600 * 1000 + offset * 86400000).toISOString().slice(0, 10);

  async function cenario() {
    const db = testDb();
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const [alpinista, soldador] = await Promise.all([
      db.commercial_Professional.create({ data: { companyId: company.id, name: 'Alpinista N2', salary: 4200 } }),
      db.commercial_Professional.create({ data: { companyId: company.id, name: 'Soldador', salary: 3800 } }),
    ]);
    return { db, company, alpinista, soldador };
  }
  const novo = (extra: Record<string, any> = {}) => ({ name: 'José da Silva', cpf: '529.982.247-25', phone: '81 99999-0000', contractType: 'clt', admissionDate: '2025-03-10', ...extra });
  const criar = (companyId: number, body: Record<string, any>, permissions?: string[]) => api().post('/employees').set(auth(companyId, permissions)).send(body);
  const evento = (companyId: number, id: number, body: Record<string, any>, permissions?: string[]) => api().post(`/employees/${id}/events`).set(auth(companyId, permissions)).send(body);

  it('cadastra com funções, valida CPF e não repete CPF nem usuário', async () => {
    const { company, alpinista, soldador } = await cenario();
    const res = await criar(company.id, novo({ roles: [alpinista.id, soldador.id], primaryRoleId: soldador.id, userId })).expect(201);
    expect(res.body.cpf).toBe('52998224725');
    expect(res.body.primaryRole).toBe('Soldador');
    expect(res.body.roles).toHaveLength(2);
    expect(res.body.status).toBe('ativo');
    expect(res.body.user.id).toBe(userId);

    await criar(company.id, novo({ name: 'Outro', cpf: '111.111.111-11' })).expect(400); // CPF inválido
    await criar(company.id, novo({ name: 'Outro' })).expect(409); // CPF repetido
    await criar(company.id, novo({ name: 'Outro', cpf: '', userId })).expect(409); // usuário já ligado
    await criar(company.id, novo({ name: 'Jo', cpf: '' })).expect(400); // nome curto
    await criar(company.id, novo({ name: 'Outro', cpf: '', roles: [999999] })).expect(400); // função inexistente
    await criar(company.id, novo({ name: 'Outro', cpf: '', contractType: 'xpto' })).expect(400);
    // sem CPF pode (cadastro rápido), e mais de um sem CPF também
    await criar(company.id, novo({ name: 'Sem CPF Um', cpf: '' })).expect(201);
    await criar(company.id, novo({ name: 'Sem CPF Dois', cpf: '' })).expect(201);
    await criar(company.id, novo({ name: 'Sem permissão', cpf: '' }), ['list_funcionarios']).expect(403);

    const list = await api().get('/employees').set(auth(company.id)).expect(200);
    expect(list.body.total).toBe(3);
    const byRole = await api().get(`/employees?professionalId=${alpinista.id}`).set(auth(company.id)).expect(200);
    expect(byRole.body.rows.map((row: any) => row.name)).toEqual(['José da Silva']);
    const byCpf = await api().get('/employees?search=529.982').set(auth(company.id)).expect(200);
    expect(byCpf.body.total).toBe(1);
  });

  it('esconde dados pessoais e histórico de quem não tem a permissão', async () => {
    const { company, db } = await cenario();
    const { body } = await criar(company.id, novo({ rg: '1234567', birthDate: '1990-05-20', email: 'jose@exemplo.com', emergencyName: 'Maria', emergencyPhone: '81 98888-0000' })).expect(201);
    await evento(company.id, body.id, { type: 'advertencia', startDate: day(-3), reason: 'Sem EPI na obra' }).expect(201);

    const semPermissao = await api().get(`/employees/${body.id}`).set(auth(company.id, BASE)).expect(200);
    expect(semPermissao.body.cpf).toBeNull();
    expect(semPermissao.body.rg).toBeNull();
    expect(semPermissao.body.birthDate).toBeNull();
    expect(semPermissao.body.emergencyName).toBeNull();
    expect(semPermissao.body.phone).toBe('81 99999-0000');
    expect(semPermissao.body.events).toEqual([]);
    expect(JSON.stringify(semPermissao.body)).not.toContain('Sem EPI');

    // quem não vê não apaga o que não vê: o CPF mandado em branco é ignorado
    await api().put(`/employees/${body.id}`).set(auth(company.id, BASE)).send({ name: 'José da Silva Filho', cpf: '', rg: '' }).expect(200);
    const row = await db.hr_Employee.findUnique({ where: { id: body.id } });
    expect(row.name).toBe('José da Silva Filho');
    expect(row.cpf).toBe('52998224725');
    expect(row.rg).toBe('1234567');
    // busca por CPF não funciona sem a permissão
    const byCpf = await api().get('/employees?search=52998224725').set(auth(company.id, BASE)).expect(200);
    expect(byCpf.body.total).toBe(0);
    // lançar no histórico pede a permissão própria
    await evento(company.id, body.id, { type: 'ferias', startDate: day(1), endDate: day(10) }, [...BASE, 'view_ocorrencias_funcionarios']).expect(403);
  });

  it('calcula a situação pelo histórico: férias, afastamento em aberto, suspensão', async () => {
    const { company } = await cenario();
    const a = (await criar(company.id, novo()).expect(201)).body;
    const b = (await criar(company.id, novo({ name: 'Ana Souza', cpf: '' })).expect(201)).body;
    const c = (await criar(company.id, novo({ name: 'Bruno Lima', cpf: '' })).expect(201)).body;

    await evento(company.id, a.id, { type: 'ferias', startDate: day(-2) }).expect(400); // férias pede o fim
    await evento(company.id, a.id, { type: 'ferias', startDate: day(-2), endDate: day(-5) }).expect(400);
    await evento(company.id, a.id, { type: 'ferias', startDate: '2020-01-01', endDate: '2020-01-10' }).expect(400); // antes da admissão
    const ferias = await evento(company.id, a.id, { type: 'ferias', startDate: day(-2), endDate: day(5) }).expect(201);
    expect(ferias.body.status).toBe('ferias');
    expect(ferias.body.statusUntil).toBe(day(5));
    await evento(company.id, a.id, { type: 'ferias', startDate: day(3), endDate: day(8) }).expect(409); // sobrepõe

    const afastado = await evento(company.id, b.id, { type: 'afastamento', startDate: day(-10) }).expect(201);
    expect(afastado.body.status).toBe('afastado');
    await evento(company.id, c.id, { type: 'suspensao', startDate: day(0), endDate: day(2) }).expect(400); // sem motivo
    await evento(company.id, c.id, { type: 'suspensao', startDate: day(0), endDate: day(2), reason: 'Falta grave' }).expect(201);
    // férias futuras não mudam a situação de hoje
    const d = (await criar(company.id, novo({ name: 'Carla Dias', cpf: '' })).expect(201)).body;
    expect((await evento(company.id, d.id, { type: 'ferias', startDate: day(10), endDate: day(20) }).expect(201)).body.status).toBe('ativo');

    const list = await api().get('/employees').set(auth(company.id)).expect(200);
    expect(list.body.summary).toEqual({ ferias: 1, afastado: 1, suspenso: 1, ativo: 1 });
    const filtered = await api().get('/employees?status=afastado').set(auth(company.id)).expect(200);
    expect(filtered.body.rows.map((row: any) => row.name)).toEqual(['Ana Souza']);
    // sem a permissão do histórico, afastado e suspenso aparecem só como indisponível
    const basic = await api().get('/employees').set(auth(company.id, BASE)).expect(200);
    expect(basic.body.summary).toEqual({ ferias: 1, indisponivel: 2, ativo: 1 });
    const one = await api().get(`/employees/${c.id}`).set(auth(company.id, BASE)).expect(200);
    expect(one.body.unavailable[0].label).toBe('Indisponível');

    // a pessoa voltou: encerrar o afastamento ontem devolve a situação
    const eventId = afastado.body.events.find((event: any) => event.type === 'afastamento').id;
    const back = await api().patch(`/employees/${b.id}/events/${eventId}`).set(auth(company.id)).send({ endDate: day(-1) }).expect(200);
    expect(back.body.status).toBe('ativo');
  });

  it('desliga pelo histórico, some da lista padrão e readmite ao tirar o registro', async () => {
    const { company, db } = await cenario();
    const { body } = await criar(company.id, novo()).expect(201);
    await evento(company.id, body.id, { type: 'desligamento', startDate: day(-1) }).expect(400); // sem motivo
    const off = await evento(company.id, body.id, { type: 'desligamento', startDate: day(-1), reason: 'Pedido de demissão' }).expect(201);
    expect(off.body.status).toBe('desligado');
    expect(off.body.terminationDate).toBe(day(-1));
    await evento(company.id, body.id, { type: 'desligamento', startDate: day(0), reason: 'De novo' }).expect(409);
    await evento(company.id, body.id, { type: 'ferias', startDate: day(1), endDate: day(5) }).expect(400); // depois do desligamento

    expect((await api().get('/employees').set(auth(company.id)).expect(200)).body.total).toBe(0);
    expect((await api().get('/employees?status=desligado').set(auth(company.id)).expect(200)).body.total).toBe(1);

    const eventId = off.body.events.find((event: any) => event.type === 'desligamento').id;
    const back = await api().delete(`/employees/${body.id}/events/${eventId}`).set(auth(company.id)).expect(200);
    expect(back.body.status).toBe('ativo');
    expect((await db.hr_Employee.findUnique({ where: { id: body.id } })).terminationDate).toBeNull();
    // o registro tirado fica guardado, inativo
    expect(await db.hr_EmployeeEvent.count({ where: { employeeId: body.id } })).toBe(1);
  });

  it('registra a mudança da função principal no histórico', async () => {
    const { company, alpinista, soldador } = await cenario();
    const { body } = await criar(company.id, novo({ roles: [alpinista.id] })).expect(201);
    const same = await api().put(`/employees/${body.id}`).set(auth(company.id)).send({ roles: [alpinista.id, soldador.id], primaryRoleId: alpinista.id }).expect(200);
    expect(same.body.events).toHaveLength(0);
    const changed = await api().put(`/employees/${body.id}`).set(auth(company.id)).send({ roles: [alpinista.id, soldador.id], primaryRoleId: soldador.id }).expect(200);
    expect(changed.body.primaryRole).toBe('Soldador');
    expect(changed.body.events[0]).toMatchObject({ type: 'mudanca_funcao', reason: 'De Alpinista N2 para Soldador', removable: false });
    await api().delete(`/employees/${body.id}/events/${changed.body.events[0].id}`).set(auth(company.id)).expect(400);
  });

  it('inativa e reativa, e não enxerga funcionário de outra empresa', async () => {
    const { company } = await cenario();
    const other = await makeCompany();
    const { body } = await criar(company.id, novo()).expect(201);
    await api().get(`/employees/${body.id}`).set(auth(other.id)).expect(404);
    await api().put(`/employees/${body.id}`).set(auth(other.id)).send({ name: 'Invasor da Silva' }).expect(404);

    await api().patch(`/employees/${body.id}/inactive`).set(auth(company.id)).expect(200);
    expect((await api().get('/employees').set(auth(company.id)).expect(200)).body.total).toBe(0);
    expect((await api().get('/employees?inactive=true').set(auth(company.id)).expect(200)).body.total).toBe(1);
    await api().patch(`/employees/${body.id}/active`).set(auth(company.id)).expect(200);
    expect((await api().get('/employees').set(auth(company.id)).expect(200)).body.total).toBe(1);
  });
});
