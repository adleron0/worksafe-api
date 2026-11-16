import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Painel de treinamentos (GET /dashboard/training).
 *
 * O que não pode quebrar: só entra quem vê turmas; dinheiro só para quem tem
 * `list_financeiro`; os avisos (quórum, a confirmar, sem pagamento, sem
 * instrutor, certificados a emitir) e a lista de reciclagem, que tira quem já
 * voltou para uma turma nova do mesmo curso.
 */
describe('Painel de treinamentos (e2e)', () => {
  const TODAY = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const day = (offset: number) => new Date(new Date(`${TODAY}T00:00:00Z`).getTime() + offset * 86400000);
  let jwt: JwtService;
  let cpf = 0;

  beforeAll(async () => {
    blockRealNetwork();
    const app = await bootTestApp();
    jwt = app.get(JwtService);
  });
  afterAll(async () => { await shutdownTestApp(); resetAsaasMock(); });
  beforeEach(async () => { await resetDb(); await flushCache(); resetAsaasMock(); });

  const auth = (companyId: number, sub: number, permissions: string[]) => ({
    Authorization: `Bearer ${jwt.sign(
      { data: encryptPayload({ sub, companyId, permissions, profile: 'admin' }) },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
    )}`,
  });
  const api = () => request(httpServer());

  async function enroll(companyId: number, classId: number, status: 'pending' | 'confirmed', name = `Aluno ${cpf + 1}`) {
    const db = testDb();
    const trainee = await db.trainee.create({ data: { name, cpf: String(10000000000 + ++cpf), phone: '81999990000' } });
    const subscription = await db.courseClassSubscription.create({
      data: { name, cpf: trainee.cpf, email: `a${cpf}@teste.local`, phone: '81999990000', companyId, classId, traineeId: trainee.id, subscribeStatus: status },
    });
    return { trainee, subscription };
  }

  async function certify(companyId: number, courseId: number, classId: number, traineeId: number, expirationDate: Date | null) {
    return testDb().traineeCourseCertificate.create({
      data: {
        companyId, courseId, classId, traineeId, expirationDate,
        fabricJsonFront: { objects: [] }, fabricJsonBack: { objects: [] }, canvasWidth: 842, canvasHeight: 595, variableToReplace: {},
      },
    });
  }

  it('sem permissão de treinamentos responde 403; com ela, sem dinheiro sem list_financeiro', async () => {
    const company = await makeCompany();
    const user = await makeSeller(company.id);
    await api().get('/dashboard/training').set(auth(company.id, user.id, ['list_financeiro'])).expect(403);

    const only = (await api().get('/dashboard/training').set(auth(company.id, user.id, ['view_treinamentos'])).expect(200)).body;
    expect(only.kpis.revenue).toBeUndefined();
    expect(only.actions).toEqual([]);
    expect(only.trend).toHaveLength(6);

    const both = (await api().get('/dashboard/training').set(auth(company.id, user.id, ['view_treinamentos', 'list_financeiro'])).expect(200)).body;
    expect(both.kpis.revenue).toMatchObject({ month: 0, open: 0 });
  });

  it('avisos, ocupação, treinados, satisfação e reciclagem', async () => {
    const company = await makeCompany();
    const user = await makeSeller(company.id);
    const db = testDb();
    const course = await makeCourse(company.id);

    // turma em 7 dias: 10 vagas, quórum 5, 2 confirmados, 1 a confirmar, sem instrutor
    const next = await makeCourseClass(company.id, course.id, {
      name: 'NR35 próxima', initialDate: day(7), finalDate: day(8), unlimitedSubscriptions: false, maxSubscriptions: 10, minimumQuorum: 5,
    });
    const a = await enroll(company.id, next.id, 'confirmed');
    await enroll(company.id, next.id, 'confirmed');
    await enroll(company.id, next.id, 'pending');
    // um confirmado com boleto em aberto e nada pago
    await db.financialRecords.create({ data: {
      companyId: company.id, subscriptionId: a.subscription.id, accrualDate: TODAY.slice(0, 7), gateway: 'manual', paymentMethod: 'boleto', status: 'waiting', value: 450, dueDate: day(3),
    } });

    // turma que terminou ontem: 3 confirmados, 1 certificado
    const past = await makeCourseClass(company.id, course.id, { name: 'NR35 passada', initialDate: day(-2), finalDate: day(-1) });
    const p1 = await enroll(company.id, past.id, 'confirmed');
    await enroll(company.id, past.id, 'confirmed');
    await enroll(company.id, past.id, 'confirmed');
    await certify(company.id, course.id, past.id, p1.trainee.id, null);
    await db.courseReview.createMany({ data: [
      { companyId: company.id, classId: past.id, courseId: course.id, generalRating: 5, authorizationExposeReview: false },
      { companyId: company.id, classId: past.id, courseId: course.id, generalRating: 4, authorizationExposeReview: false },
    ] });
    await db.courseClassExam.createMany({ data: [
      { companyId: company.id, classId: past.id, courseId: course.id, traineeId: p1.trainee.id, examResponses: [], result: true },
      { companyId: company.id, classId: past.id, courseId: course.id, traineeId: p1.trainee.id, examResponses: [], result: false },
    ] });

    // reciclagem: dois certificados vencendo em 30 dias; um dos alunos já está na turma futura
    const old = await makeCourseClass(company.id, course.id, { name: 'NR35 antiga', initialDate: day(-700), finalDate: day(-699) });
    const r1 = await enroll(company.id, old.id, 'confirmed', 'Bruno Reciclar');
    await certify(company.id, course.id, old.id, r1.trainee.id, day(30));
    await certify(company.id, course.id, old.id, a.trainee.id, day(30)); // `a` já se inscreveu na próxima

    const body = (await api().get('/dashboard/training').set(auth(company.id, user.id, ['list_classes'])).expect(200)).body;
    const keys = body.actions.map((x: any) => x.key);
    expect(keys[0]).toBe(`quorum-${next.id}`);
    expect(keys).toEqual(expect.arrayContaining([`pending-${next.id}`, `unpaid-${next.id}`, `instructor-${next.id}`, `certs-${past.id}`]));
    expect(body.actions.find((x: any) => x.key === `certs-${past.id}`).count).toBe(2);
    expect(body.actions.find((x: any) => x.key === `unpaid-${next.id}`).count).toBe(1);

    expect(body.kpis.occupancy).toMatchObject({ taken: 2, seats: 10, classes: 1 });
    // a turma passada terminou ontem; conta no mês se ontem ainda for deste mês
    const yesterdayThisMonth = day(-1).toISOString().slice(0, 7) === TODAY.slice(0, 7);
    expect(body.kpis.trained.value).toBe(yesterdayThisMonth ? 3 : 0);
    expect(body.kpis.quality).toMatchObject({ rating: 4.5, reviews: 2, approval: 0.5, exams: 2 });

    expect(body.upcoming[0]).toMatchObject({ id: next.id, enrolled: 2, pending: 1, seats: 10, quorum: 5, instructors: 0 });
    expect(body.renewals.total).toBe(1);
    expect(body.renewals.items[0]).toMatchObject({ trainee: 'Bruno Reciclar', course: course.name });
    expect(body.renewals.byCourse).toEqual([{ courseId: course.id, name: course.name, count: 1 }]);
  });
});
