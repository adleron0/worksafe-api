import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';

/**
 * Certificado cancelado e vencido na verificação pública.
 *
 * Quem lê o QR de um certificado cancelado precisa ver "cancelado" (com
 * motivo e o novo, se reemitido) — "não encontrado" parece documento falso.
 * O vencido continua aparecendo, e a vitrine filtra "só válidos" com OR.
 */
describe('Cancelamento e vencimento do certificado (e2e)', () => {
  const jwt = new JwtService();
  let userId = 0;
  const auth = (companyId: number) => {
    const payload = {
      sub: userId,
      companyId,
      permissions: ['list_classes', 'update_classes', 'inactive_classes', 'activate_classes'],
      profile: 'admin',
    };
    return {
      Authorization: `Bearer ${jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}`,
    };
  };
  const api = () => request(httpServer());

  beforeAll(async () => {
    await bootTestApp();
  });
  afterAll(async () => {
    await shutdownTestApp();
  });
  beforeEach(async () => {
    await resetDb();
    await flushCache();
  });

  async function cenario() {
    const db = testDb();
    const company = await makeCompany();
    userId = (await makeSeller(company.id, { name: 'Gestora' })).id;
    const course = await makeCourse(company.id);
    await db.course.update({ where: { id: course.id }, data: { icon: 'hard-hat', color: '#0AC319' } });
    const turma = await makeCourseClass(company.id, course.id);
    const trainee = await db.trainee.create({ data: { name: 'Ana Lima', cpf: '30809540070' } });
    const cert = (data: Record<string, unknown> = {}) =>
      db.traineeCourseCertificate.create({
        data: {
          courseId: course.id,
          traineeId: trainee.id,
          classId: turma.id,
          companyId: company.id,
          fabricJsonFront: { objects: [] },
          ...data,
        },
      });
    return { db, company, course, cert };
  }

  it('cancelar grava motivo e substituto; o status público mostra só o mínimo', async () => {
    const { db, company, cert } = await cenario();
    const antigo = await cert();
    const novo = await cert();

    await api()
      .put(`/trainee-certificate/${antigo.id}`)
      .set(auth(company.id))
      .send({ cancelReason: 'Emitido com dados errados e reemitido', replacedByKey: novo.key })
      .expect((r) => expect(r.status).toBeLessThan(300));
    await api()
      .patch(`/trainee-certificate/inactive/${antigo.id}`)
      .set(auth(company.id))
      .expect((r) => expect(r.status).toBeLessThan(300));

    const salvo = await db.traineeCourseCertificate.findUniqueOrThrow({ where: { id: antigo.id } });
    expect(salvo.inactiveAt).not.toBeNull();

    const res = await api().get(`/trainee-certificate/public/${antigo.key}/status`).expect(200);
    expect(res.body).toMatchObject({
      status: 'cancelado',
      key: antigo.key,
      reason: 'Emitido com dados errados e reemitido',
      replacedByKey: novo.key,
      traineeName: 'Ana Lima',
      course: { icon: 'hard-hat', color: '#0AC319' },
    });
    // nada do desenho nem CPF
    expect(res.body.fabricJsonFront).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('30809540070');
  });

  it('substituto cancelado também não é oferecido', async () => {
    const { db, cert } = await cenario();
    const novo = await cert({ inactiveAt: new Date() });
    const antigo = await cert({ inactiveAt: new Date(), replacedByKey: novo.key });
    void db;
    const res = await api().get(`/trainee-certificate/public/${antigo.key}/status`).expect(200);
    expect(res.body.replacedByKey).toBeNull();
  });

  it('certificado vivo não tem status de cancelado (404)', async () => {
    const { cert } = await cenario();
    const vivo = await cert();
    await api().get(`/trainee-certificate/public/${vivo.key}/status`).expect(404);
  });

  it('vitrine "só válidos": vence no futuro OU sem validade; o vencido fica de fora', async () => {
    const { cert } = await cenario();
    const futuro = new Date(Date.now() + 86400000 * 30);
    const passado = new Date(Date.now() - 86400000 * 30);
    await cert({ expirationDate: futuro });
    await cert({ expirationDate: null });
    const vencido = await cert({ expirationDate: passado });

    const now = new Date().toISOString();
    const res = await api()
      .get('/trainee-certificate/public')
      .query({ 'or.0.gte-expirationDate': now, 'or.1.null-expirationDate': 'true', limit: 50 })
      .expect(200);
    const ids = res.body.rows.map((r: { id: number }) => r.id);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(vencido.id);

    // sem o filtro, o vencido aparece (histórico)
    const all = await api().get('/trainee-certificate/public').query({ limit: 50 }).expect(200);
    expect(all.body.rows.map((r: { id: number }) => r.id)).toContain(vencido.id);
  });
});
