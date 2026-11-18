import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, flushCache, httpServer, shutdownTestApp } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';
import { TraineeCertificateService } from 'src/features/training/trainee_certificate/service';

/**
 * Empresa que compra vagas numa turma aberta.
 *
 * A reserva segura as vagas (o site para de vender), os alunos da empresa
 * entram sem checkout e sem cobrança, e o certificado deles sai com a empresa
 * contratante — a da inscrição, não a do cadastro do aluno.
 */
describe('Vagas de empresa em turma aberta (e2e)', () => {
  const ALL = ['list_classes', 'create_classes', 'update_classes', 'list_comercial', 'update_comercial', 'list_financeiro', 'view_dashboard'];
  let jwt: JwtService;
  let certificates: TraineeCertificateService;
  let userId = 0;
  let cnpjSeq = 0;
  let cpfSeq = 100000000;

  beforeAll(async () => {
    blockRealNetwork();
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    certificates = app.get(TraineeCertificateService);
  });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  beforeEach(async () => { await resetDb(); await flushCache(); resetAsaasMock(); });

  const auth = (companyId: number, permissions: string[] = ALL) => ({
    Authorization: `Bearer ${jwt.sign(
      { data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
    )}`,
  });
  const api = () => request(httpServer());

  /** CPF válido e diferente a cada chamada. */
  function cpf() {
    const base = String(++cpfSeq).padStart(9, '0').split('').map(Number);
    const dv = (nums: number[]) => { const sum = nums.reduce((s, n, i) => s + n * (nums.length + 1 - i), 0); const r = (sum * 10) % 11; return r === 10 ? 0 : r; };
    const d1 = dv(base);
    const d2 = dv([...base, d1]);
    return [...base, d1, d2].join('');
  }

  async function makeCustomer(companyId: number, name = 'Indústria Alfa', document?: string) {
    const db = testDb();
    const rank = await db.dOM_Ranks.create({ data: { name: 'A', companyId } });
    const state = (await db.dOM_States.findFirst()) ?? (await db.dOM_States.create({ data: { name: 'Pernambuco', uf: 'PE' } }));
    const city = (await db.dOM_Cities.findFirst()) ?? (await db.dOM_Cities.create({ data: { name: 'Recife', stateId: state.id } }));
    return db.customer.create({ data: {
      name, corporateName: `${name} SA`, cnpj: document ?? String(11222333000100 + ++cnpjSeq), companyId,
      rankId: rank.id, phone: '8133334444', email: 'compras@alfa.local', stateId: state.id, cityId: city.id,
    } });
  }

  async function cenario(max = 5) {
    const company = await makeCompany();
    userId = (await makeSeller(company.id)).id;
    const course = await makeCourse(company.id, { yearOfValidation: 2 });
    const template = await testDb().couseCertificate.create({ data: { name: 'Modelo', courseId: course.id, companyId: company.id, fabricJsonFront: { objects: [] }, fabricJsonBack: { objects: [] } } });
    const turma = await makeCourseClass(company.id, course.id, {
      allowCheckout: false, unlimitedSubscriptions: false, maxSubscriptions: max, certificateId: template.id, openClass: true,
      initialDate: new Date(Date.now() + 10 * 86400000), finalDate: new Date(Date.now() + 11 * 86400000),
    });
    const customer = await makeCustomer(company.id);
    return { company, course, template, turma, customer, h: auth(company.id) };
  }

  async function contrato(companyId: number, customerId: number, courseId: number, students = 3) {
    return testDb().commercial_Contract.create({ data: {
      companyId, number: `CT-2026-${String(++cnpjSeq).padStart(4, '0')}`, year: 2026, sequence: cnpjSeq, proposalId: 900000 + cnpjSeq,
      customerId, kind: 'treinamento', title: 'NR-35 para a equipe', value: 1500, acceptedAt: new Date(), sellerId: userId,
      classes: [{ courseId, description: 'NR-35', quantity: 1, students, workload: 8, dates: '', location: '', classIds: [] }],
    } });
  }

  const subscribeAsSite = (classId: number, extra: Record<string, string> = {}) => {
    const req = api().post('/subscription/subscribe');
    Object.entries({ name: 'Aluno do Site', cpf: cpf(), email: 'site@teste.local', phone: '81999998888', classId: String(classId), ...extra }).forEach(([k, v]) => req.field(k, v));
    return req;
  };

  it('reserva ocupa vagas: o site e a listagem pública passam a ver a turma lotada', async () => {
    const { turma, customer, h } = await cenario(5);
    await subscribeAsSite(turma.id).expect(201);
    // duas confirmadas pelo sistema
    for (let i = 0; i < 2; i++) {
      await api().post('/subscription').set(h).send({ classId: turma.id, name: `Avulso ${i}`, cpf: cpf(), email: 'a@a.local', phone: '81900000000', subscribeStatus: 'confirmed' }).expect(201);
    }
    // 3 livres: reservar 4 não cabe
    const tooMany = await api().post('/class-reservations').set(h).send({ classId: turma.id, customerId: customer.id, seats: 4 }).expect(409);
    expect(tooMany.body.message).toContain('3 vaga(s) livre(s)');
    const reservation = (await api().post('/class-reservations').set(h).send({ classId: turma.id, customerId: customer.id, seats: 3, unitValue: '450,00' }).expect(201)).body;
    expect(reservation).toMatchObject({ seats: 3, used: 0, open: 3, unitValue: 450, classSeats: { max: 5, confirmed: 2, reserved: 3, occupied: 5, free: 0 } });

    // o site não vende mais
    const blocked = await subscribeAsSite(turma.id).expect(400);
    expect(blocked.body.message).toContain('limite');
    // nem o sistema, sem reserva
    await api().post('/subscription').set(h).send({ classId: turma.id, name: 'Outro', cpf: cpf(), email: 'b@b.local', phone: '81900000000', subscribeStatus: 'confirmed' }).expect(409);
    // listagem pública: _count = ocupadas
    const pub = (await api().get(`/classes?id=${turma.id}&show=_count`).expect(200)).body;
    const row = (pub.rows ?? pub)[0];
    expect(row._count.subscriptions).toBe(5);
    expect(row.seats).toMatchObject({ free: 0, reservedOpen: 3 });
  });

  it('aumentar o limite da turma é explícito e só para quem gerencia turmas', async () => {
    const { company, turma, customer, h } = await cenario(2);
    await api().post('/class-reservations').set(auth(company.id, ['list_comercial', 'update_comercial'])).send({ classId: turma.id, customerId: customer.id, seats: 4, raiseLimit: true }).expect(403);
    const ok = (await api().post('/class-reservations').set(h).send({ classId: turma.id, customerId: customer.id, seats: 4, raiseLimit: true }).expect(201)).body;
    expect(ok.classSeats).toMatchObject({ max: 4, free: 0 });
    // turma fechada não recebe reserva
    const closed = await makeCourseClass(company.id, turma.courseId, { customerId: customer.id, allowCheckout: false });
    await api().post('/class-reservations').set(h).send({ classId: closed.id, customerId: customer.id, seats: 1 }).expect(400);
  });

  it('alunos da empresa entram confirmados, sem cobrança, com a empresa e a venda; o resto volta explicado', async () => {
    const { company, course, turma, customer, h } = await cenario(10);
    const ct = await contrato(company.id, customer.id, course.id, 3);
    // item da venda vendeu 3 vagas: reservar 4 passa do vendido
    await api().post('/class-reservations').set(h).send({ classId: turma.id, contractId: ct.id, contractSlotIndex: 0, seats: 4 }).expect(409);
    const reservation = (await api().post('/class-reservations').set(h).send({ classId: turma.id, contractId: ct.id, contractSlotIndex: 0, seats: 3 }).expect(201)).body;
    expect(reservation).toMatchObject({ customerId: customer.id, contract: { id: ct.id, number: ct.number } });

    // um CPF já pendente pelo site (sem cobrança) é convertido
    const pendingCpf = cpf();
    await subscribeAsSite(turma.id, { cpf: pendingCpf, name: 'João Pendente' }).expect(201);
    const [a, b] = [cpf(), cpf()];
    const res = (await api().post(`/class-reservations/${reservation.id}/students`).set(h).send({ students: [
      { name: 'Ana Lima', cpf: a }, { name: 'Bruno Melo', cpf: b }, { name: 'Repetido', cpf: a }, { name: 'Sem CPF', cpf: '123' },
      { name: 'João Pendente', cpf: pendingCpf }, { name: 'Quarta Pessoa', cpf: cpf() },
    ] }).expect(201)).body;
    expect(res.results.map((r: any) => r.status)).toEqual(['inscrito', 'inscrito', 'erro', 'erro', 'convertido', 'erro']);
    expect(res.results[5].message).toContain('3 vaga(s)');
    expect(res.reservation).toMatchObject({ used: 3, open: 0 });

    const subs = await testDb().courseClassSubscription.findMany({ where: { reservationId: reservation.id }, include: { financialRecords: true } });
    expect(subs).toHaveLength(3);
    for (const s of subs) {
      expect(s).toMatchObject({ subscribeStatus: 'confirmed', customerId: customer.id, contractId: ct.id, origin: 'contrato', workedAt: 'Indústria Alfa' });
      expect(s.traineeId).toBeTruthy();
      expect(s.financialRecords).toHaveLength(0);
    }
    expect(await testDb().financialRecords.count()).toBe(0);
    // a venda mostra o item com as vagas reservadas
    const options = (await api().get(`/class-reservations/contract/${ct.id}`).set(h).expect(200)).body;
    expect(options.slots[0]).toMatchObject({ sold: 3, reserved: 3, missing: 0 });

    // trocar e tirar aluno; cancelar só sem alunos
    const ana = subs.find((s) => s.cpf === a)!;
    await api().post(`/class-reservations/${reservation.id}/cancel`).set(h).send({}).expect(409);
    const novo = cpf();
    await api().put(`/class-reservations/${reservation.id}/students/${ana.id}`).set(h).send({ name: 'Carla Nova', cpf: novo }).expect(200);
    expect((await testDb().courseClassSubscription.findUnique({ where: { id: ana.id } }))!.cpf).toBe(novo);
    // com presença não troca
    await testDb().courseClassAttendanceList.create({ data: { day: 1, IsPresent: true, traineeId: subs.find((s) => s.cpf === b)!.traineeId!, classId: turma.id, companyId: company.id } });
    await api().delete(`/class-reservations/${reservation.id}/students/${subs.find((s) => s.cpf === b)!.id}`).set(h).expect(409);
    await api().delete(`/class-reservations/${reservation.id}/students/${ana.id}`).set(h).expect(200);
    const after = (await api().get(`/class-reservations/${reservation.id}`).set(h).expect(200)).body;
    expect(after).toMatchObject({ used: 2, open: 1 });
    // relatório da empresa
    const report = (await api().get(`/class-reservations/${reservation.id}/report`).set(h).expect(200)).body;
    expect(report.days).toEqual([1]);
    expect(report.students.find((s: any) => s.cpf === b).attendance).toEqual([true]);
  });

  it('certificado: empresa e CNPJ da contratante só nos alunos dela; aluno multiempresa leva a empresa de cada turma', async () => {
    const { company, course, template, turma, customer, h } = await cenario(10);
    const reservation = (await api().post('/class-reservations').set(h).send({ classId: turma.id, customerId: customer.id, seats: 2 }).expect(201)).body;
    const shared = cpf();
    await api().post(`/class-reservations/${reservation.id}/students`).set(h).send({ students: [{ name: 'Ana Lima', cpf: shared }] }).expect(201);
    // aluno do site na mesma turma, que digitou a empresa dele
    await api().post('/subscription').set(h).send({ classId: turma.id, name: 'Site', cpf: cpf(), email: 's@s.local', phone: '81900000000', workedAt: 'Padaria do Zé', subscribeStatus: 'confirmed' }).expect(201);

    await certificates.generateCertificates(turma.id, company.id);
    const certs = await testDb().traineeCourseCertificate.findMany({ where: { classId: turma.id }, include: { trainee: true } });
    const ana = certs.find((c) => c.trainee.cpf === shared)!.variableToReplace as any;
    const site = certs.find((c) => c.trainee.cpf !== shared)!.variableToReplace as any;
    expect(ana.inscricao_empresa.value).toBe('INDÚSTRIA ALFA SA');
    expect(ana.inscricao_empresa_cnpj.value).toMatch(/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/);
    expect(ana.contratante_nome.value).toBe('INDÚSTRIA ALFA SA');
    expect(site.inscricao_empresa.value).toBe('Padaria do Zé');
    expect(site.inscricao_empresa_cnpj).toBeUndefined();

    // a mesma aluna, noutra turma, por outra empresa
    const beta = await makeCustomer(company.id, 'Construtora Beta');
    const turma2 = await makeCourseClass(company.id, course.id, { allowCheckout: false, certificateId: template.id });
    const r2 = (await api().post('/class-reservations').set(h).send({ classId: turma2.id, customerId: beta.id, seats: 1 }).expect(201)).body;
    await api().post(`/class-reservations/${r2.id}/students`).set(h).send({ students: [{ name: 'Ana Lima', cpf: shared }] }).expect(201);
    await certificates.generateCertificates(turma2.id, company.id);
    const second = (await testDb().traineeCourseCertificate.findFirstOrThrow({ where: { classId: turma2.id } })).variableToReplace as any;
    expect(second.inscricao_empresa.value).toBe('CONSTRUTORA BETA SA');
    // o primeiro certificado não mudou
    const first = (await testDb().traineeCourseCertificate.findFirstOrThrow({ where: { classId: turma.id, trainee: { cpf: shared } } })).variableToReplace as any;
    expect(first.inscricao_empresa.value).toBe('INDÚSTRIA ALFA SA');
    expect(await testDb().trainee.count({ where: { cpf: shared } })).toBe(1);
  });

  it('turma fechada: o cliente da turma vai para o certificado; cliente pessoa física não vira empresa', async () => {
    const { company, course, template, customer, h } = await cenario(10);
    const closed = await makeCourseClass(company.id, course.id, { customerId: customer.id, allowCheckout: false, certificateId: template.id });
    await api().post('/subscription').set(h).send({ classId: closed.id, name: 'Func', cpf: cpf(), email: 'f@f.local', phone: '81900000000', subscribeStatus: 'confirmed' }).expect(201);
    const person = await makeCustomer(company.id, 'Fulano', cpf());
    await api().post('/subscription').set(h).send({ classId: closed.id, name: 'PF', cpf: cpf(), email: 'p@p.local', phone: '81900000000', customerId: person.id, workedAt: 'Autônomo', subscribeStatus: 'confirmed' }).expect(201);
    await certificates.generateCertificates(closed.id, company.id);
    const vars = (await testDb().traineeCourseCertificate.findMany({ where: { classId: closed.id }, include: { trainee: true } })).map((c) => [c.trainee.name, (c.variableToReplace as any).inscricao_empresa?.value]);
    // a inscrição com cliente PF cai para a empresa da turma (a PF não é empresa)
    expect(vars.sort()).toEqual([['Func', 'INDÚSTRIA ALFA SA'], ['PF', 'INDÚSTRIA ALFA SA']]);
    // cliente de outra base é recusado
    const other = await makeCompany();
    const foreign = await makeCustomer(other.id, 'Estranha');
    await api().post('/subscription').set(h).send({ classId: closed.id, name: 'X', cpf: cpf(), email: 'x@x.local', phone: '81900000000', customerId: foreign.id }).expect(400);
    // mesmo CPF duas vezes pelo sistema: recusado
    const dup = cpf();
    await api().post('/subscription').set(h).send({ classId: closed.id, name: 'D', cpf: dup, email: 'd@d.local', phone: '81900000000' }).expect(201);
    await api().post('/subscription').set(h).send({ classId: closed.id, name: 'D2', cpf: dup, email: 'd@d.local', phone: '81900000000' }).expect(409);
  });

  it('transferir reserva leva vagas e alunos; mudança de data avisa o vendedor no acompanhamento', async () => {
    const { company, course, turma, customer, h } = await cenario(10);
    const ct = await contrato(company.id, customer.id, course.id, 2);
    const reservation = (await api().post('/class-reservations').set(h).send({ classId: turma.id, contractId: ct.id, contractSlotIndex: 0, seats: 2 }).expect(201)).body;
    await api().post(`/class-reservations/${reservation.id}/students`).set(h).send({ students: [{ name: 'Ana', cpf: cpf() }] }).expect(201);

    // muda a data da turma → tarefa no acompanhamento do cliente, para o vendedor
    const newDate = new Date(Date.now() + 20 * 86400000).toISOString();
    await api().put(`/classes/${turma.id}`).set(h).send({ initialDate: newDate }).expect(200);
    const tasks = await testDb().commercial_Activity.findMany({ where: { customerId: customer.id } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ type: 'tarefa', userId, subject: 'Avisar a empresa: a turma mudou de data' });
    expect(tasks[0].notes).toContain(ct.number);
    // turma com reserva não vira fechada
    await api().put(`/classes/${turma.id}`).set(h).send({ customerId: customer.id }).expect(409);

    const destino = await makeCourseClass(company.id, course.id, { allowCheckout: false, unlimitedSubscriptions: false, maxSubscriptions: 1 });
    // destino com 1 vaga e a reserva pede 2
    await api().post(`/class-reservations/${reservation.id}/transfer`).set(h).send({ classId: destino.id }).expect(409);
    const moved = (await api().post(`/class-reservations/${reservation.id}/transfer`).set(h).send({ classId: destino.id, raiseLimit: true }).expect(201)).body;
    expect(moved).toMatchObject({ classId: destino.id, used: 1, classSeats: { max: 2, free: 0 } });
    expect(await testDb().courseClassSubscription.count({ where: { reservationId: reservation.id, classId: destino.id } })).toBe(1);
    // outro curso não
    const otherCourse = await makeCourse(company.id, { name: 'NR-33' });
    const wrong = await makeCourseClass(company.id, otherCourse.id, { allowCheckout: false });
    await api().post(`/class-reservations/${reservation.id}/transfer`).set(h).send({ classId: wrong.id }).expect(400);
  });

  it('painel de treinamentos conta vagas de empresa na ocupação e mostra as vagas vendidas', async () => {
    const { company, turma, customer, h } = await cenario(10);
    await testDb().courseClass.update({ where: { id: turma.id }, data: { initialDate: new Date(Date.now() + 2 * 86400000), finalDate: new Date(Date.now() + 3 * 86400000), minimumQuorum: 4 } });
    await api().post('/class-reservations').set(h).send({ classId: turma.id, customerId: customer.id, seats: 4, unitValue: 300 }).expect(201);
    const dash = (await api().get('/dashboard/training').set(h).expect(200)).body;
    expect(dash.kpis.occupancy).toMatchObject({ taken: 4, seats: 10 });
    expect(dash.kpis.companySeats).toEqual({ seats: 4, customers: 1, value: 1200 });
    expect(dash.upcoming[0]).toMatchObject({ enrolled: 0, reserved: 4, companySeats: 4 });
    // quórum atingido pelas vagas da empresa; alerta de vagas sem nome
    expect(dash.actions.some((a: any) => a.key === `quorum-${turma.id}`)).toBe(false);
    expect(dash.actions.find((a: any) => a.key === `names-${turma.id}`)).toMatchObject({ count: 4 });
    expect(company.id).toBeTruthy();
  });
});
