import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { EmailService } from 'src/features/email/email.service';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass, makeSeller } from './setup/factories';

/**
 * Reenvio do certificado por e-mail (POST /trainee-certificate/send-email).
 *
 * O aluno é multiempresa e pode ter vários cursos: empresa (config de e-mail,
 * nome) e curso vêm da turma do certificado enviado — antes vinham da
 * "primeira empresa do banco" e da primeira inscrição do aluno.
 */
describe('Reenvio do certificado por e-mail (e2e)', () => {
  const jwt = new JwtService();
  let email: EmailService;
  let userId = 0;
  let configs: Array<{ host: string; user: string }> = [];
  let sent: Array<{ to: string; subject: string; html: string }> = [];

  const auth = (companyId: number) => ({
    Authorization: `Bearer ${jwt.sign(
      { data: encryptPayload({ sub: userId, companyId, permissions: ['update_classes'], profile: 'admin' }) },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
    )}`,
  });
  const send = (companyId: number, body: { traineeId: number; certificateKey: string }) =>
    request(httpServer()).post('/trainee-certificate/send-email').set(auth(companyId)).send(body);

  beforeAll(async () => {
    const app = await bootTestApp();
    email = app.get(EmailService);
  });
  afterAll(async () => {
    await shutdownTestApp();
  });
  beforeEach(async () => {
    await resetDb();
    await flushCache();
    configs = [];
    sent = [];
    jest.restoreAllMocks();
    jest.spyOn(email, 'initialize').mockImplementation((c: any) => {
      configs.push({ host: c.host, user: c.auth?.user });
    });
    jest.spyOn(email, 'sendEmail').mockImplementation(async (o: any) => {
      sent.push({ to: String(o.to), subject: o.subject, html: o.html ?? '' });
    });
  });

  const emailConfig = (tag: string) => ({
    EMAIL_HOST: `smtp.${tag}.test`,
    EMAIL_PORT: '587',
    EMAIL_AUTH_USER: `envio@${tag}.test`,
    EMAIL_AUTH_PASSWORD: 'segredo',
  });

  async function empresa(tag: string, name: string) {
    return makeCompany({ comercial_name: name, email_conection: emailConfig(tag) });
  }

  async function certificado(companyId: number, traineeId: number, courseName: string) {
    const db = testDb();
    const course = await makeCourse(companyId, { name: courseName });
    const turma = await makeCourseClass(companyId, course.id, { name: `Turma ${courseName}` });
    await db.courseClassSubscription.create({
      data: { classId: turma.id, traineeId, name: 'Ana Lima', cpf: '30809540070', email: 'ana@aluno.test', phone: '11999999999', subscribeStatus: 'confirmed' },
    });
    return db.traineeCourseCertificate.create({
      data: { courseId: course.id, traineeId, classId: turma.id, companyId, fabricJsonFront: { objects: [] } },
    });
  }

  const aluna = () => testDb().trainee.create({ data: { name: 'Ana Lima', cpf: '30809540070', email: 'ana@aluno.test' } });

  it('aluno com dois cursos recebe o nome do curso do certificado enviado', async () => {
    const company = await empresa('ws', 'WorkSafe Teste');
    userId = (await makeSeller(company.id, { name: 'Gestora' })).id;
    const trainee = await aluna();
    await certificado(company.id, trainee.id, 'NR-35 Trabalho em Altura'); // primeira inscrição
    const segundo = await certificado(company.id, trainee.id, 'NR-33 Espaço Confinado');

    await send(company.id, { traineeId: trainee.id, certificateKey: segundo.key }).expect(201);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ana@aluno.test');
    expect(sent[0].subject).toContain('NR-33 Espaço Confinado');
    expect(sent[0].subject).not.toContain('NR-35');
    expect(sent[0].html).toContain(segundo.key);
  });

  it('com duas empresas, usa a config de e-mail e o nome da empresa da turma', async () => {
    // A "outra" nasce primeiro: o bug antigo pegava a primeira empresa do banco.
    await empresa('outra', 'Outra Empresa');
    const company = await empresa('dona', 'Empresa Dona da Turma');
    userId = (await makeSeller(company.id, { name: 'Gestora' })).id;
    const trainee = await aluna();
    const cert = await certificado(company.id, trainee.id, 'NR-35 Trabalho em Altura');

    await send(company.id, { traineeId: trainee.id, certificateKey: cert.key }).expect(201);

    expect(configs).toEqual([{ host: 'smtp.dona.test', user: 'envio@dona.test' }]);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('Empresa Dona da Turma');
    expect(sent[0].subject).not.toContain('Outra Empresa');
  });

  it('certificado de outra empresa é recusado e nada é enviado', async () => {
    const outra = await empresa('outra', 'Outra Empresa');
    const minha = await empresa('minha', 'Minha Empresa');
    userId = (await makeSeller(minha.id, { name: 'Gestora' })).id;
    const trainee = await aluna(); // mesmo aluno nas duas empresas
    await certificado(minha.id, trainee.id, 'NR-10 Elétrica');
    const alheio = await certificado(outra.id, trainee.id, 'NR-35 Trabalho em Altura');

    const res = await send(minha.id, { traineeId: trainee.id, certificateKey: alheio.key });
    expect(res.status).toBe(403);
    expect(String(res.body.message)).toMatch(/outra empresa/i);
    expect(configs).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('chave de outro aluno ou certificado cancelado não são enviados', async () => {
    const company = await empresa('ws', 'WorkSafe Teste');
    userId = (await makeSeller(company.id, { name: 'Gestora' })).id;
    const trainee = await aluna();
    const outro = await testDb().trainee.create({ data: { name: 'Bruno', cpf: '52998224725', email: 'bruno@aluno.test' } });
    const cert = await certificado(company.id, trainee.id, 'NR-35 Trabalho em Altura');

    await send(company.id, { traineeId: outro.id, certificateKey: cert.key }).expect(404);
    await testDb().traineeCourseCertificate.update({ where: { id: cert.id }, data: { inactiveAt: new Date() } });
    await send(company.id, { traineeId: trainee.id, certificateKey: cert.key }).expect(404);
    expect(sent).toHaveLength(0);
  });
});
