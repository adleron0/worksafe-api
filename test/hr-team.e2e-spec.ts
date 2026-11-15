import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { orderPeriod, overlaps, shiftsClash, spansOf } from 'src/features/hr/allocation';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';

/**
 * Equipe da OS e do RDO pelo cadastro de funcionários: a pessoa escalada aponta
 * para o cadastro (ou segue avulsa), a função casa pelo cadastro para o custo,
 * "só as minhas" vale pelo funcionário, e quem escala vê disponibilidade e documentos.
 */
describe('Equipe pelo cadastro de funcionários (e2e)', () => {
  const OS = ['list_ordens_de_servico', 'view_ordens_de_servico', 'update_ordens_de_servico', 'update_rdo', 'all_ordens_de_servico', 'view_custos_comercial'];
  const RH = ['list_funcionarios', 'view_funcionarios', 'create_funcionarios', 'update_funcionarios', 'update_ocorrencias_funcionarios', 'view_documentos_funcionarios', 'update_documentos_funcionarios'];
  const ALL = [...OS, ...RH];
  let jwt: JwtService;
  let userId = 0;

  beforeAll(async () => {
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); });

  const auth = (companyId: number, permissions: string[] = ALL, sub = userId) => {
    const payload = { sub, companyId, permissions, profile: 'admin' };
    return { Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}` };
  };
  const api = () => request(httpServer());
  const day = (offset: number) => new Date(Date.now() - 3 * 3600 * 1000 + offset * 86400000).toISOString().slice(0, 10);
  const date = (offset: number) => new Date(`${day(offset)}T00:00:00.000Z`);

  async function cenario() {
    const db = testDb();
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const [alpinista, soldador] = await Promise.all([
      db.commercial_Professional.create({ data: { companyId: company.id, name: 'Alpinista N2', salary: 4200 } }),
      db.commercial_Professional.create({ data: { companyId: company.id, name: 'Soldador', salary: 3800 } }),
    ]);
    const novo = async (name: string, roles: number[], extra: Record<string, any> = {}) => (await api().post('/employees').set(auth(company.id)).send({ name, roles, ...extra }).expect(201)).body;
    // a empresa já abriu os documentos uma vez: os tipos padrão existem (ASO obrigatório)
    await api().get('/hr-documents/types').set(auth(company.id)).expect(200);
    const jose = await novo('José da Silva', [alpinista.id, soldador.id]);
    const ana = await novo('Ana Souza', [soldador.id]);
    const os = (number: number, extra: Record<string, any> = {}) => db.service_Order.create({ data: {
      companyId: company.id, number: `OS-2026-000${number}`, year: 2026, sequence: number, contractId: 9000 + number, proposalId: 9000 + number, customerId: 9000 + number,
      title: `Obra ${number}`, status: 'agendada', scope: [], checklist: [], plannedStart: date(5), plannedEnd: date(15), ...extra,
    } });
    return { db, company, alpinista, soldador, jose, ana, os };
  }
  const equipe = (companyId: number, id: number, team: any[], permissions?: string[]) => api().put(`/service-orders/${id}`).set(auth(companyId, permissions)).send({ team });

  it('regras puras: período da obra e alocações que saem da equipe', () => {
    const base = { plannedStart: date(5), plannedEnd: date(15), startedAt: null, finishedAt: null };
    expect(orderPeriod({ ...base, status: 'agendada' }, day(0))).toEqual({ start: day(5), end: day(15) });
    expect(orderPeriod({ ...base, status: 'agendada', plannedStart: null }, day(0))).toEqual({ start: null, end: null });
    // em execução e passou do previsto: segue até hoje
    expect(orderPeriod({ status: 'em_execucao', plannedStart: date(-20), plannedEnd: date(-5), startedAt: date(-18), finishedAt: null }, day(0))).toEqual({ start: day(-18), end: day(0) });
    expect(orderPeriod({ status: 'concluida', plannedStart: date(-20), plannedEnd: date(-5), startedAt: date(-18), finishedAt: date(-7) }, day(0))).toEqual({ start: day(-18), end: day(-7) });
    expect(overlaps('2026-01-10', '2026-01-20', '2026-01-20', null)).toBe(true);
    expect(overlaps('2026-01-10', '2026-01-19', '2026-01-20', null)).toBe(false);
    const spans = spansOf([{ id: 1, number: 'OS-1', title: 'Obra', status: 'agendada', ...base, team: [{ name: 'Avulso', role: 'Ajudante' }, { name: 'José', role: 'Alpinista', employeeId: 7 }, { name: 'Ana', role: 'Soldador', employeeId: 8, from: day(8), to: day(9) }] }], day(0));
    expect(spans.map((span) => [span.employeeId, span.start, span.end])).toEqual([[7, day(5), day(15)], [8, day(8), day(9)]]);
  });

  it('grava a pessoa do cadastro com nome, função e usuário, e mantém a pessoa avulsa', async () => {
    const { company, jose, alpinista, soldador, os, db } = await cenario();
    const order = await os(1);
    const saved = (await equipe(company.id, order.id, [
      { employeeId: jose.id }, // função principal entra sozinha
      { name: 'Diarista João', role: 'Ajudante' }, // avulso, como antes
    ]).expect(200)).body;
    expect(saved.team[0]).toMatchObject({ name: 'José da Silva', role: 'Alpinista N2', employeeId: jose.id, professionalId: alpinista.id, userId: null });
    expect(saved.team[1]).toEqual({ name: 'Diarista João', role: 'Ajudante', userId: null });
    // outra função que a pessoa exerce, e um período dentro da obra
    const other = (await equipe(company.id, order.id, [{ employeeId: jose.id, professionalId: soldador.id, from: day(6), to: day(8) }]).expect(200)).body;
    expect(other.team[0]).toMatchObject({ role: 'Soldador', professionalId: soldador.id, from: day(6), to: day(8) });

    await equipe(company.id, order.id, [{ employeeId: 999999 }]).expect(400);
    await equipe(company.id, order.id, [{ employeeId: jose.id }, { employeeId: jose.id }]).expect(400); // duas vezes
    await equipe(company.id, order.id, [{ employeeId: jose.id, from: day(8), to: day(6) }]).expect(400);
    await equipe(company.id, order.id, [{ employeeId: jose.id, professionalId: 999999 }]).expect(400);
    // funcionário de outra empresa não entra
    const other2 = await makeCompany();
    const stranger = await db.hr_Employee.create({ data: { companyId: other2.id, name: 'De Fora' } });
    await equipe(company.id, order.id, [{ employeeId: stranger.id }]).expect(400);
  });

  it('"só as minhas": o funcionário escalado vê a OS, inclusive quando o login é ligado depois', async () => {
    const { company, jose, os, db } = await cenario();
    const order = await os(1);
    const other = await os(2);
    const campo = await makeSeller(company.id);
    const FIELD = ['list_ordens_de_servico', 'view_ordens_de_servico', 'update_rdo'];
    await equipe(company.id, order.id, [{ employeeId: jose.id }]).expect(200);
    const mine = () => api().get('/service-orders?limit=50').set(auth(company.id, FIELD, campo.id)).expect(200);
    expect((await mine()).body.rows).toHaveLength(0);
    // o login é ligado ao funcionário depois de a equipe já estar gravada
    await api().put(`/employees/${jose.id}`).set(auth(company.id)).send({ userId: campo.id }).expect(200);
    const rows = (await mine()).body.rows;
    expect(rows.map((row: any) => row.id)).toEqual([order.id]);
    await api().get(`/service-orders/${other.id}`).set(auth(company.id, FIELD, campo.id)).expect(404);
    // e quem é escalado já com login leva o usuário na equipe
    const saved = (await equipe(company.id, other.id, [{ employeeId: jose.id }]).expect(200)).body;
    expect(saved.team[0].userId).toBe(campo.id);
    expect(await db.service_Order.count()).toBe(2);
  });

  it('mostra a quem escala quem está livre, em outra obra, de férias e com documento pendente', async () => {
    const { company, jose, ana, os } = await cenario();
    const order = await os(1); // dias 5 a 15
    const busy = await os(2, { plannedStart: date(10), plannedEnd: date(20) });
    await equipe(company.id, busy.id, [{ employeeId: jose.id }]).expect(200);
    await api().post(`/employees/${ana.id}/events`).set(auth(company.id)).send({ type: 'suspensao', startDate: day(12), endDate: day(14), reason: 'Falta grave' }).expect(201);

    const res = await api().get(`/service-orders/${order.id}/team-options`).set(auth(company.id, OS)).expect(200);
    expect(res.body).toMatchObject({ from: day(5), to: day(15) });
    const of = (name: string) => res.body.employees.find((employee: any) => employee.name === name);
    expect(of('José da Silva')).toMatchObject({ free: false, busy: [{ number: 'OS-2026-0002', start: day(10), end: day(20) }], unavailable: [] });
    // sem a permissão do histórico, a suspensão aparece só como indisponível, sem motivo
    expect(of('Ana Souza')).toMatchObject({ free: false, busy: [], unavailable: [{ label: 'Indisponível', start: day(12), end: day(14) }] });
    expect(JSON.stringify(res.body)).not.toContain('Falta grave');
    // ASO é obrigatório e ninguém enviou
    expect(of('José da Silva').documents).toEqual([expect.objectContaining({ typeName: 'ASO', kind: 'faltando' })]);
    expect(of('José da Silva').roles.map((role: any) => role.name)).toEqual(['Alpinista N2', 'Soldador']);
    // a própria obra não conta como "outra obra"
    await equipe(company.id, order.id, [{ employeeId: ana.id }]).expect(200);
    const again = await api().get(`/service-orders/${order.id}/team-options?from=${day(5)}&to=${day(9)}`).set(auth(company.id, OS)).expect(200);
    expect(again.body.employees.find((employee: any) => employee.name === 'Ana Souza')).toMatchObject({ free: true, busy: [] });
    expect(again.body.employees.find((employee: any) => employee.name === 'José da Silva').free).toBe(true); // a outra obra começa no dia 10
    // quem foi desligado antes do início não é oferecido
    await api().post(`/employees/${ana.id}/events`).set(auth(company.id)).send({ type: 'desligamento', startDate: day(0), reason: 'Pedido' }).expect(201);
    const gone = await api().get(`/service-orders/${order.id}/team-options`).set(auth(company.id, OS)).expect(200);
    expect(gone.body.employees.map((employee: any) => employee.name)).toEqual(['José da Silva']);
    await api().get(`/service-orders/${order.id}/team-options`).set(auth(company.id, RH)).expect(403);
  });

  it('mapa de alocação: escalado, trabalhou, indisponível e sem data', async () => {
    const { company, jose, ana, os } = await cenario();
    const MAP = ['view_alocacao', 'list_funcionarios', 'view_funcionarios'];
    const running = await os(1, { status: 'em_execucao', startedAt: date(-3), plannedStart: date(-3), plannedEnd: date(4) });
    const future = await os(2, { plannedStart: date(10), plannedEnd: date(20) });
    const undated = await os(3, { plannedStart: null, plannedEnd: null, status: 'a_mobilizar' });
    await os(4, { status: 'cancelada', team: [{ name: 'José da Silva', role: 'Alpinista N2', employeeId: jose.id }] });
    await equipe(company.id, running.id, [{ employeeId: jose.id }, { name: 'Diarista', role: 'Ajudante' }]).expect(200);
    await equipe(company.id, future.id, [{ employeeId: jose.id, from: day(12), to: day(14) }, { employeeId: ana.id }]).expect(200);
    await equipe(company.id, undated.id, [{ employeeId: ana.id }]).expect(200);
    await api().post(`/service-orders/${running.id}/reports`).set(auth(company.id, OS)).send({ date: day(-1), crew: [{ name: 'José da Silva', role: 'Alpinista N2', hours: 8, overtime: 1, employeeId: jose.id }] }).expect(201);
    await api().post(`/employees/${ana.id}/events`).set(auth(company.id)).send({ type: 'afastamento', startDate: day(1) }).expect(201);

    const res = (await api().get(`/employees/allocation?from=${day(-5)}&to=${day(15)}`).set(auth(company.id, MAP)).expect(200)).body;
    expect(res).toMatchObject({ today: day(0), from: day(-5), to: day(15) });
    expect(res.employees.map((employee: any) => employee.name)).toEqual(['Ana Souza', 'José da Silva']);
    const spans = (id: number) => res.spans.filter((span: any) => span.employeeId === id).map((span: any) => [span.number, span.start, span.end]);
    // a obra em execução vai até o fim previsto; a futura, só o período da pessoa; a cancelada não entra
    expect(spans(jose.id)).toEqual([['OS-2026-0001', day(-3), day(4)], ['OS-2026-0002', day(12), day(14)]]);
    expect(spans(ana.id)).toEqual([['OS-2026-0002', day(10), day(20)]]);
    expect(res.undated.map((span: any) => [span.employeeId, span.number])).toEqual([[ana.id, 'OS-2026-0003']]);
    expect(res.worked).toEqual([{ employeeId: jose.id, date: day(-1), orderId: running.id, hours: 9 }]);
    // sem a permissão do histórico, o afastamento aparece só como indisponível
    expect(res.unavailable).toEqual([{ employeeId: ana.id, start: day(1), end: null, label: 'Indisponível' }]);
    const full = (await api().get(`/employees/allocation?from=${day(-5)}&to=${day(15)}`).set(auth(company.id, [...MAP, 'view_ocorrencias_funcionarios'])).expect(200)).body;
    expect(full.unavailable[0].label).toBe('Afastamento');
    // janela que não toca nada
    const empty = (await api().get(`/employees/allocation?from=${day(40)}&to=${day(50)}`).set(auth(company.id, MAP)).expect(200)).body;
    expect(empty.spans).toEqual([]);
    expect(empty.unavailable).toHaveLength(1); // afastamento em aberto continua
    // a ficha: só a pessoa
    const one = (await api().get(`/employees/${jose.id}/allocation?from=${day(-5)}&to=${day(15)}`).set(auth(company.id, MAP)).expect(200)).body;
    expect(one.employees).toHaveLength(1);
    expect(one.spans).toHaveLength(2);
    await api().get('/employees/allocation').set(auth(company.id, ['list_funcionarios', 'view_funcionarios'])).expect(403);
    await api().get(`/employees/allocation?from=${day(5)}&to=${day(1)}`).set(auth(company.id, MAP)).expect(400);
  });

  it('parte do dia: manhã numa obra e tarde em outra não se cruzam, e o RDO do turno traz quem está nele', async () => {
    const { company, jose, ana, os } = await cenario();
    expect(shiftsClash('manha', 'tarde')).toBe(false);
    expect(shiftsClash('manha', 'manha')).toBe(true);
    expect(shiftsClash('integral', 'noite')).toBe(true);
    const a = await os(1, { status: 'em_execucao', startedAt: date(-2), plannedStart: date(-2), plannedEnd: date(6) });
    const b = await os(2, { plannedStart: date(0), plannedEnd: date(6) });
    const saved = (await equipe(company.id, a.id, [{ employeeId: jose.id, shift: 'manha' }, { employeeId: ana.id }]).expect(200)).body;
    expect(saved.team[0].shift).toBe('manha');
    expect(saved.team[1]).not.toHaveProperty('shift'); // dia inteiro não grava nada
    await equipe(company.id, a.id, [{ employeeId: jose.id, shift: 'madrugada' }]).expect(400);
    await equipe(company.id, a.id, [{ employeeId: jose.id, shift: 'manha' }, { employeeId: ana.id }]).expect(200);
    await equipe(company.id, b.id, [{ employeeId: jose.id, shift: 'tarde' }]).expect(200);

    // quem escala a obra B vê que o José está na obra A, e em que parte do dia
    const options = (await api().get(`/service-orders/${b.id}/team-options`).set(auth(company.id, OS)).expect(200)).body;
    const jo = options.employees.find((employee: any) => employee.name === 'José da Silva');
    expect(jo.busy).toEqual([expect.objectContaining({ number: 'OS-2026-0001', shift: 'manha' })]);

    const map = (await api().get(`/employees/allocation?from=${day(-3)}&to=${day(7)}`).set(auth(company.id, ['view_alocacao'])).expect(200)).body;
    expect(map.spans.filter((span: any) => span.employeeId === jose.id).map((span: any) => [span.number, span.shift])).toEqual([['OS-2026-0001', 'manha'], ['OS-2026-0002', 'tarde']]);

    // RDO da tarde na obra A: o José (só de manhã) não vem; a Ana (dia inteiro) vem
    const tarde = (await api().get(`/service-orders/${a.id}/reports/template?shift=tarde`).set(auth(company.id, OS)).expect(200)).body;
    expect(tarde.shift).toBe('tarde');
    expect(tarde.crew.map((member: any) => member.name)).toEqual(['Ana Souza']);
    const dia = (await api().get(`/service-orders/${a.id}/reports/template`).set(auth(company.id, OS)).expect(200)).body;
    expect(dia.crew.map((member: any) => member.name)).toEqual(['José da Silva', 'Ana Souza']);
  });

  it('atividades fora de OS: lançar, alterar, cancelar, e aparecer no mapa e para quem escala', async () => {
    const { company, jose, ana, os } = await cenario();
    const VIEW = ['view_alocacao'];
    const WRITE = ['view_alocacao', 'update_alocacao'];
    const types = (await api().get('/hr-activities/types').set(auth(company.id, VIEW)).expect(200)).body;
    expect(types.rows.map((type: any) => type.name)).toEqual(expect.arrayContaining(['Aula como instrutor', 'Atividade no CT', 'Sobreaviso']));
    const typeId = (name: string) => types.rows.find((type: any) => type.name === name).id;
    expect(types.rows.find((type: any) => type.name === 'Sobreaviso').occupies).toBe(false);

    const novo = (body: Record<string, any>, permissions = WRITE) => api().post('/hr-activities').set(auth(company.id, permissions)).send(body);
    const aula = (await novo({ typeId: typeId('Aula como instrutor'), employeeIds: [jose.id, ana.id], startDate: day(2), endDate: day(3), shift: 'manha', location: 'CT Recife', notes: 'NR-35 turma 12' }).expect(201)).body;
    expect(aula).toMatchObject({ typeName: 'Aula como instrutor', startDate: day(2), endDate: day(3), shift: 'manha', location: 'CT Recife', occupies: true });
    expect(aula.employees.map((employee: any) => employee.name)).toEqual(['José da Silva', 'Ana Souza']);
    await novo({ typeId: typeId('Sobreaviso'), employeeIds: [ana.id], startDate: day(2) }).expect(201); // um dia só, dia inteiro
    await novo({ typeId: typeId('Atividade no CT'), employeeIds: [], startDate: day(2) }).expect(400);
    await novo({ typeId: 999999, employeeIds: [jose.id], startDate: day(2) }).expect(400);
    await novo({ typeId: typeId('Atividade no CT'), employeeIds: [jose.id], startDate: day(5), endDate: day(2) }).expect(400);
    await novo({ typeId: typeId('Atividade no CT'), employeeIds: [jose.id], startDate: day(2), shift: 'x' }).expect(400);
    await novo({ typeId: typeId('Atividade no CT'), employeeIds: [999999], startDate: day(2) }).expect(400);
    await novo({ typeId: typeId('Atividade no CT'), employeeIds: [jose.id], startDate: day(2) }, VIEW).expect(403);
    const other = await makeCompany();
    await api().get(`/hr-activities/${aula.id}`).set(auth(other.id, WRITE)).expect(404);

    const map = (await api().get(`/employees/allocation?from=${day(0)}&to=${day(7)}`).set(auth(company.id, VIEW)).expect(200)).body;
    expect(map.activities.map((span: any) => [span.employeeId, span.typeName, span.start, span.end, span.shift, span.occupies]).sort()).toEqual([
      [ana.id, 'Aula como instrutor', day(2), day(3), 'manha', true], [ana.id, 'Sobreaviso', day(2), day(2), 'integral', false], [jose.id, 'Aula como instrutor', day(2), day(3), 'manha', true],
    ].sort());
    // para quem escala: a aula ocupa; o sobreaviso não
    const order = await os(1, { plannedStart: date(1), plannedEnd: date(4) });
    const options = (await api().get(`/service-orders/${order.id}/team-options`).set(auth(company.id, OS)).expect(200)).body;
    const an = options.employees.find((employee: any) => employee.name === 'Ana Souza');
    expect(an.free).toBe(false);
    expect(an.activities).toEqual([expect.objectContaining({ typeName: 'Aula como instrutor', shift: 'manha' })]);

    // tirar a Ana e mudar para a tarde
    const edited = (await api().put(`/hr-activities/${aula.id}`).set(auth(company.id, WRITE)).send({ employeeIds: [jose.id], shift: 'tarde' }).expect(200)).body;
    expect(edited).toMatchObject({ shift: 'tarde', startDate: day(2), endDate: day(3) });
    expect(edited.employees).toHaveLength(1);
    await api().delete(`/hr-activities/${aula.id}`).set(auth(company.id, VIEW)).expect(403);
    await api().delete(`/hr-activities/${aula.id}`).set(auth(company.id, WRITE)).expect(200);
    const after = (await api().get(`/hr-activities?from=${day(0)}&to=${day(7)}`).set(auth(company.id, VIEW)).expect(200)).body;
    expect(after.rows.map((row: any) => row.typeName)).toEqual(['Sobreaviso']);

    // tipos: criar, não repetir nome, inativar
    const type = (await api().post('/hr-activities/types').set(auth(company.id, WRITE)).send({ name: 'Manutenção de equipamentos', color: '#123abc', occupies: true }).expect(201)).body;
    await api().post('/hr-activities/types').set(auth(company.id, WRITE)).send({ name: 'sobreaviso' }).expect(409);
    await api().post('/hr-activities/types').set(auth(company.id, WRITE)).send({ name: 'Cor errada', color: 'azul' }).expect(400);
    await api().patch(`/hr-activities/types/${type.id}/inactive`).set(auth(company.id, WRITE)).expect(200);
    await novo({ typeId: type.id, employeeIds: [jose.id], startDate: day(2) }).expect(400); // tipo inativo
  });

  it('turmas viram alocação pelo CPF: quem dá aula e quem é aluno, sem lançamento', async () => {
    const { company, db, os } = await cenario();
    const PERSONAL = [...ALL, 'view_dados_pessoais_funcionarios'];
    const cpfOf = async (name: string, cpf: string) => (await api().post('/employees').set(auth(company.id, PERSONAL)).send({ name, cpf }).expect(201)).body;
    const instrutor = await cpfOf('Paulo Instrutor', '529.982.247-25');
    const aluno = await cpfOf('Rita Aluna', '111.444.777-35');
    const course = await makeCourse(company.id);
    const at = (offset: number, hour: string) => new Date(`${day(offset)}T${hour}:00.000-03:00`);
    const turma = await makeCourseClass(company.id, course.id, { name: 'NR-35 turma 12', initialDate: at(3, '08:00'), finalDate: at(4, '17:00'), address: 'Rua do CT, 100', city: 'Recife', state: 'PE' });
    // instrutor cadastrado com o CPF formatado; aluno inscrito e confirmado com o CPF só em dígitos
    const teacher = await db.instructor.create({ data: { name: 'Paulo Instrutor', companyId: company.id, email: 'paulo@teste.local', cpf: '529.982.247-25', curriculum: 'x', formation: 'x' } });
    await db.courseClassInstructor.create({ data: { classId: turma.id, instructorId: teacher.id, companyId: company.id } });
    await db.courseClassSubscription.create({ data: { name: 'Rita Aluna', cpf: '11144477735', email: 'rita@teste.local', phone: '81', companyId: company.id, classId: turma.id, subscribeStatus: 'confirmed' } });
    // não contam: inscrição pendente, turma sem fim à vista, turma inativa, e quem não é funcionário
    await db.courseClassSubscription.create({ data: { name: 'Paulo Instrutor', cpf: '52998224725', email: 'p@teste.local', phone: '81', companyId: company.id, classId: turma.id, subscribeStatus: 'confirmed' } }); // dá a aula: não vira aluno
    await db.courseClassSubscription.create({ data: { name: 'De Fora', cpf: '39053344705', email: 'f@teste.local', phone: '81', companyId: company.id, classId: turma.id, subscribeStatus: 'confirmed' } });
    const aberta = await makeCourseClass(company.id, course.id, { name: 'Turma aberta', initialDate: at(-100, '08:00'), finalDate: at(200, '17:00') });
    await db.courseClassSubscription.create({ data: { name: 'Rita Aluna', cpf: '11144477735', email: 'rita@teste.local', phone: '81', companyId: company.id, classId: aberta.id, subscribeStatus: 'confirmed' } });
    const pendente = await makeCourseClass(company.id, course.id, { name: 'Turma pendente', initialDate: at(3, '08:00'), finalDate: at(3, '17:00') });
    await db.courseClassSubscription.create({ data: { name: 'Rita Aluna', cpf: '11144477735', email: 'rita@teste.local', phone: '81', companyId: company.id, classId: pendente.id, subscribeStatus: 'pending' } });

    const map = (await api().get(`/employees/allocation?from=${day(0)}&to=${day(7)}`).set(auth(company.id, ['view_alocacao'])).expect(200)).body;
    expect(map.classes.map((span: any) => [span.employeeId, span.className, span.role, span.start, span.end, span.location]).sort()).toEqual([
      [instrutor.id, 'NR-35 turma 12', 'instrutor', day(3), day(4), 'Rua do CT, 100 · Recife/PE'],
      [aluno.id, 'NR-35 turma 12', 'aluno', day(3), day(4), 'Rua do CT, 100 · Recife/PE'],
    ].sort());
    expect(map.classes[0].courseName).toBe('NR-35 Trabalho em Altura');
    // fora da janela não aparece
    expect((await api().get(`/employees/allocation?from=${day(10)}&to=${day(12)}`).set(auth(company.id, ['view_alocacao'])).expect(200)).body.classes).toEqual([]);

    // para quem escala uma obra nesses dias, os dois aparecem ocupados com a turma
    const order = await os(1, { plannedStart: date(2), plannedEnd: date(5) });
    const options = (await api().get(`/service-orders/${order.id}/team-options`).set(auth(company.id, OS)).expect(200)).body;
    const of = (name: string) => options.employees.find((employee: any) => employee.name === name);
    expect(of('Paulo Instrutor')).toMatchObject({ free: false, activities: [{ typeName: 'Aula: NR-35 turma 12', start: day(3), end: day(4) }] });
    expect(of('Rita Aluna')).toMatchObject({ free: false, activities: [{ typeName: 'Treinamento: NR-35 turma 12' }] });
    // mudou a data da turma, mudou a alocação
    await db.courseClass.update({ where: { id: turma.id }, data: { initialDate: at(20, '08:00'), finalDate: at(21, '17:00') } });
    expect((await api().get(`/service-orders/${order.id}/team-options`).set(auth(company.id, OS)).expect(200)).body.employees.find((employee: any) => employee.name === 'Paulo Instrutor').free).toBe(true);
  });

  it('RDO: a equipe do dia vem do cadastro e a Minha esteira avisa de documento pendente na equipe', async () => {
    const { company, jose, alpinista, os } = await cenario();
    const order = await os(1, { status: 'em_execucao', startedAt: date(-3), plannedStart: date(-3), plannedEnd: date(10) });
    await equipe(company.id, order.id, [{ employeeId: jose.id }, { name: 'Diarista João', role: 'Ajudante' }]).expect(200);

    const blank = (await api().get(`/service-orders/${order.id}/reports/template`).set(auth(company.id, OS)).expect(200)).body;
    expect(blank.crew[0]).toMatchObject({ name: 'José da Silva', role: 'Alpinista N2', employeeId: jose.id, professionalId: alpinista.id });
    expect(blank.crew[1].employeeId).toBeUndefined();

    const body = { date: day(-1), crew: blank.crew.map((member: any) => ({ ...member, hours: 8 })), activities: 'Montagem' };
    const created = (await api().post(`/service-orders/${order.id}/reports`).set(auth(company.id, OS)).send(body).expect(201)).body;
    expect(created.crew[0]).toMatchObject({ employeeId: jose.id, professionalId: alpinista.id, hours: 8 });
    expect(created.crew[1]).not.toHaveProperty('employeeId');
    await api().post(`/service-orders/${order.id}/reports`).set(auth(company.id, OS)).send({ date: day(-2), crew: [{ name: 'Fantasma', role: 'X', hours: 8, employeeId: 999999 }] }).expect(400);
    // o RDO seguinte herda a equipe de ontem com a ligação ao cadastro
    const next = (await api().get(`/service-orders/${order.id}/reports/template`).set(auth(company.id, OS)).expect(200)).body;
    expect(next.crew[0]).toMatchObject({ employeeId: jose.id, professionalId: alpinista.id });

    const mine = await api().get('/my-pipeline').set(auth(company.id, OS)).expect(200);
    const block = mine.body.blocks.find((item: any) => item.key === 'equipe_documentos');
    expect(block).toMatchObject({ count: 1, items: [{ title: 'José da Silva', link: `/servicos/ordens-de-servico/${order.id}` }] });
    expect(block.items[0].subtitle).toContain('ASO faltando');
  });
});
