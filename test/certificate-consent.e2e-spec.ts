import './setup/env'; // precisa ser o primeiro import

import { bootTestApp, shutdownTestApp } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeCourse, makeCourseClass } from './setup/factories';
import { TraineeCertificateService } from 'src/features/training/trainee_certificate/service';

/**
 * Consentimento de exibição pública do certificado.
 *
 * O aluno responde na prova se autoriza aparecer na vitrine/preview. A
 * emissão lia um campo inexistente da inscrição com `|| true` e publicava
 * todo mundo — inclusive quem recusou.
 */
describe('Consentimento do certificado (e2e)', () => {
  let service: TraineeCertificateService;

  beforeAll(async () => {
    const app = await bootTestApp();
    service = app.get(TraineeCertificateService);
  });

  afterAll(async () => {
    await shutdownTestApp();
  });

  beforeEach(async () => {
    await resetDb();
  });

  async function cenario(opts: { allowExam: boolean }) {
    const db = testDb();
    const company = await makeCompany();
    const course = await makeCourse(company.id, { yearOfValidation: 2 });
    const template = await db.couseCertificate.create({
      data: {
        name: 'Modelo',
        courseId: course.id,
        companyId: company.id,
        fabricJsonFront: { objects: [] },
        fabricJsonBack: { objects: [] },
      },
    });
    const turma = await makeCourseClass(company.id, course.id, {
      allowExam: opts.allowExam,
      certificateId: template.id,
    });
    const trainee = await db.trainee.create({
      data: { name: 'Ana Lima', cpf: '30809540070' },
    });
    const subscription = await db.courseClassSubscription.create({
      data: {
        name: trainee.name,
        cpf: trainee.cpf,
        email: 'ana@teste.local',
        phone: '81900000000',
        companyId: company.id,
        classId: turma.id,
        traineeId: trainee.id,
        subscribeStatus: 'confirmed',
      },
    });
    const prova = (showOnWebsiteConsent: boolean) =>
      db.courseClassExam.create({
        data: {
          traineeId: trainee.id,
          courseId: course.id,
          classId: turma.id,
          companyId: company.id,
          examResponses: [],
          result: true,
          showOnWebsiteConsent,
        },
      });
    const certificado = () =>
      db.traineeCourseCertificate.findFirstOrThrow({
        where: { traineeId: trainee.id, classId: turma.id },
      });
    return { company, turma, subscription, prova, certificado };
  }

  it('aluno que recusou na prova não é publicado', async () => {
    const c = await cenario({ allowExam: true });
    await c.prova(false);

    await service.generateCertificates(c.turma.id, c.company.id, [c.subscription.id]);

    expect((await c.certificado()).showOnWebsiteConsent).toBe(false);
  });

  it('aluno que autorizou na prova é publicado', async () => {
    const c = await cenario({ allowExam: true });
    await c.prova(true);

    await service.generateCertificates(c.turma.id, c.company.id, [c.subscription.id]);

    expect((await c.certificado()).showOnWebsiteConsent).toBe(true);
  });

  it('turma sem prova mantém o padrão (true)', async () => {
    const c = await cenario({ allowExam: false });

    await service.generateCertificates(c.turma.id, c.company.id);

    expect((await c.certificado()).showOnWebsiteConsent).toBe(true);
  });

  it('reemissão (upsert) não sobrescreve o consentimento já gravado', async () => {
    const c = await cenario({ allowExam: true });
    await c.prova(true);
    await service.generateCertificates(c.turma.id, c.company.id, [c.subscription.id]);
    const cert = await c.certificado();
    // Admin retira da vitrine a pedido do aluno
    await testDb().traineeCourseCertificate.update({
      where: { id: cert.id },
      data: { showOnWebsiteConsent: false },
    });

    await service.generateCertificates(c.turma.id, c.company.id, [c.subscription.id], true, true);

    expect((await c.certificado()).showOnWebsiteConsent).toBe(false);
  });
});
