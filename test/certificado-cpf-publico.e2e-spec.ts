import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import {
  bootTestApp,
  httpServer,
  shutdownTestApp,
  flushCache,
} from './setup/app';
import { resetDb, testDb } from './setup/db';
import {
  makeCompany,
  makeCourse,
  makeCourseClass,
  makeSeller,
} from './setup/factories';
import {
  certificateUnlockToken,
  maskCertificateVariables,
  maskCpf,
} from 'src/features/training/trainee_certificate/cpf-unlock';

/**
 * CPF no certificado público (LGPD):
 * - busca/página sem selo → CPFs (aluno e instrutor) mascarados, sem nascimento;
 * - QR Code (link com ?u=selo), CPF digitado certo ou empresa logada → completo.
 */
describe('CPF no certificado público (e2e)', () => {
  const jwt = new JwtService();
  let userId = 0;
  const auth = (companyId: number) => ({
    Authorization: `Bearer ${jwt.sign(
      {
        data: encryptPayload({
          sub: userId,
          companyId,
          permissions: ['list_classes'],
          profile: 'admin',
        }),
      },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
    )}`,
  });
  const api = () => request(httpServer());
  const CPF = '30809540070';
  const INSTRUTOR = '02401513485';

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
    const turma = await makeCourseClass(company.id, course.id);
    const trainee = await db.trainee.create({
      data: { name: 'Ana Lima', cpf: CPF },
    });
    const cert = await db.traineeCourseCertificate.create({
      data: {
        courseId: course.id,
        traineeId: trainee.id,
        classId: turma.id,
        companyId: company.id,
        showOnWebsiteConsent: true,
        fabricJsonFront: { objects: [] },
        variableToReplace: {
          aluno_nome: { type: 'string', value: 'ANA LIMA' },
          aluno_cpf: { type: 'string', value: '308.095.400-70' },
          aluno_data_nascimento: { type: 'string', value: '01/01/1990' },
          instrutor_cpf: { type: 'string', value: INSTRUTOR },
          instrutor_cpf_2: { type: 'string', value: INSTRUTOR },
        },
      },
    });
    return { company, key: cert.key as string };
  }

  it('máscara deixa só 3 dígitos do meio, para aluno e instrutores', () => {
    expect(maskCpf('308.095.400-70')).toBe('***.***.400-**');
    const out = maskCertificateVariables({
      aluno_cpf: { value: CPF },
      instrutor_cpf_3: { value: INSTRUTOR },
      aluno_data_nascimento: { value: '01/01/1990' },
      aluno_nome: { value: 'ANA' },
    });
    expect(out).toEqual({
      aluno_cpf: { value: '***.***.400-**' },
      instrutor_cpf_3: { value: '***.***.134-**' },
      aluno_data_nascimento: { value: '**/**/****' },
      aluno_nome: { value: 'ANA' },
    });
  });

  it('vitrine e página vinda da busca: nenhum CPF completo (aluno nem instrutor)', async () => {
    const { key } = await cenario();
    for (const url of [
      '/trainee-certificate/public',
      `/trainee-certificate/public?key=${key}`,
    ]) {
      const res = await api().get(url).expect(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('308.095.400-70');
      expect(text).not.toContain(INSTRUTOR);
      expect(text).not.toContain('01/01/1990');
      expect(res.body.rows[0].variableToReplace.instrutor_cpf.value).toBe(
        '***.***.134-**',
      );
    }
  });

  it('link do QR Code (?u=selo) mostra o certificado completo, inclusive o CPF do instrutor', async () => {
    const { key } = await cenario();
    const res = await api()
      .get(
        `/trainee-certificate/public?key=${key}&u=${certificateUnlockToken(key)}`,
      )
      .expect(200);
    const vars = res.body.rows[0].variableToReplace;
    expect(vars.aluno_cpf.value).toBe('308.095.400-70');
    expect(vars.instrutor_cpf.value).toBe(INSTRUTOR);
    // selo de outro certificado ou inventado não vale
    const other = await api()
      .get(
        `/trainee-certificate/public?key=${key}&u=${certificateUnlockToken('00000000-0000-0000-0000-000000000000')}`,
      )
      .expect(200);
    expect(other.body.rows[0].variableToReplace.aluno_cpf.value).toBe(
      '***.***.400-**',
    );
  });

  it('CPF digitado certo devolve o selo; errado recusa; 5 erros travam o certificado', async () => {
    const { key } = await cenario();
    const ok = await api()
      .post(`/trainee-certificate/public/${key}/unlock`)
      .send({ cpf: '308.095.400-70' })
      .expect(200);
    expect(ok.body.u).toBe(certificateUnlockToken(key));

    for (let i = 0; i < 5; i++) {
      await api()
        .post(`/trainee-certificate/public/${key}/unlock`)
        .send({ cpf: '11144477735' })
        .expect(403);
    }
    await api()
      .post(`/trainee-certificate/public/${key}/unlock`)
      .send({ cpf: CPF })
      .expect(429);
  });

  it('imagem e PDF: sem selo saem mascarados, com selo completos (cache privado)', async () => {
    const { key } = await cenario();
    const masked = await api()
      .get(`/trainee-certificate/public/${key}/image.png`)
      .expect(200);
    expect(masked.headers.etag).toMatch(/-m"$/);
    expect(masked.headers['cache-control']).toContain('public');
    const full = await api()
      .get(
        `/trainee-certificate/public/${key}/image.png?u=${certificateUnlockToken(key)}`,
      )
      .expect(200);
    expect(full.headers.etag).toMatch(/-f"$/);
    expect(full.headers['cache-control']).toContain('private');
    const pdf = await api()
      .get(
        `/trainee-certificate/public/${key}/certificate.pdf?u=${certificateUnlockToken(key)}`,
      )
      .expect(200);
    expect(pdf.headers['cache-control']).toContain('private');
  });

  it('empresa logada recebe o selo dos próprios certificados, não dos de outra empresa', async () => {
    const { company, key } = await cenario();
    const res = await api()
      .get(`/trainee-certificate/unlock/${key}`)
      .set(auth(company.id))
      .expect(200);
    expect(res.body.u).toBe(certificateUnlockToken(key));
    const outra = await makeCompany();
    await api()
      .get(`/trainee-certificate/unlock/${key}`)
      .set(auth(outra.id))
      .expect(404);
    await api().get(`/trainee-certificate/unlock/${key}`).expect(401);
  });
});
