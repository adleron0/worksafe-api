import './setup/env'; // precisa ser o primeiro import
import * as request from 'supertest';
import {
  bootTestApp,
  flushCache,
  httpServer,
  shutdownTestApp,
} from './setup/app';
import { resetDb, testDb } from './setup/db';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';
import {
  makeCheckoutScenario,
  makeCompany,
  makeCourse,
  makeCourseClass,
} from './setup/factories';

/**
 * Rotas públicas do aluno (sem login):
 * - N1 vitrine de certificados não entrega CPF/nascimento nem aceita filtro por CPF;
 * - N2 prova só com CPF + código da turma (ou sessão do validate-student), sem gabarito na resposta;
 * - N4 nenhuma rota pública de aluno aceita arquivo (multipart só de campos);
 * - M3 inscrição pública só em turma aberta no site.
 */
describe('Segurança das rotas públicas do aluno (e2e)', () => {
  beforeAll(async () => {
    blockRealNetwork();
    await bootTestApp();
  });
  afterAll(async () => {
    await shutdownTestApp();
    resetAsaasMock();
  });
  beforeEach(async () => {
    await resetDb();
    await flushCache();
    resetAsaasMock();
  });

  const CPF = '11144477735'; // válido para o @IsCpf do validate-student
  const CODE = 'AB12';
  const exam = [
    {
      question: '1+1?',
      options: [
        { text: '2', isCorrect: true },
        { text: '3', isCorrect: false },
      ],
    },
    {
      question: '2+2?',
      options: [
        { text: '4', isCorrect: true },
        { text: '5', isCorrect: false },
      ],
    },
  ];
  // respostas erradas: reprova e não passa pela emissão de certificado
  const wrong = JSON.stringify({
    answers: [
      { questionIndex: 0, selectedOption: 1 },
      { questionIndex: 1, selectedOption: 1 },
    ],
  });

  /** multipart como o front (post() do api.ts manda FormData) */
  const form = (url: string, fields: Record<string, string | number>) => {
    const req = request(httpServer()).post(url);
    Object.entries(fields).forEach(([k, v]) => req.field(k, String(v)));
    return req;
  };

  async function provaCenario() {
    const db = testDb();
    const company = await makeCompany();
    const course = await makeCourse(company.id, { exam, media: 6 } as any);
    const turma = await makeCourseClass(company.id, course.id, {
      allowExam: true,
      classCode: CODE,
    });
    const trainee = await db.trainee.create({
      data: { name: 'Ana Lima', cpf: CPF },
    });
    await db.courseClassSubscription.create({
      data: {
        name: trainee.name,
        cpf: CPF,
        email: 'ana@teste.local',
        phone: '81900000000',
        companyId: company.id,
        classId: turma.id,
        traineeId: trainee.id,
        subscribeStatus: 'confirmed',
      },
    });
    return { company, course, turma, trainee };
  }

  describe('N2 – prova', () => {
    it('só traineeId + classId (sem validar antes) é recusado e nada é gravado', async () => {
      const { turma, trainee } = await provaCenario();
      await form('/exames/register', {
        traineeId: trainee.id,
        classId: turma.id,
        examResponses: wrong,
      }).expect(400);
      expect(await testDb().courseClassExam.count()).toBe(0);
    });

    it('CPF ou código errados são recusados', async () => {
      const { turma, trainee } = await provaCenario();
      await form('/exames/register', {
        traineeId: trainee.id,
        classId: turma.id,
        cpf: CPF,
        classCode: 'ZZZZ',
        examResponses: wrong,
      }).expect(400);
      await form('/exames/register', {
        traineeId: trainee.id,
        classId: turma.id,
        cpf: '52998224725',
        classCode: CODE,
        examResponses: wrong,
      }).expect(400);
      // CPF de um aluno com traineeId de outro
      await form('/exames/register', {
        traineeId: trainee.id + 999,
        classId: turma.id,
        cpf: CPF,
        classCode: CODE,
        examResponses: wrong,
      }).expect(400);
      expect(await testDb().courseClassExam.count()).toBe(0);
    });

    it('com CPF + código: grava e a resposta não traz a prova corrigida', async () => {
      const { turma, trainee } = await provaCenario();
      const res = await form('/exames/register', {
        classId: turma.id,
        cpf: CPF,
        classCode: CODE,
        examResponses: wrong,
      }).expect(201);
      expect(res.body).toMatchObject({
        approved: false,
        nota: 0,
        correctAnswers: 0,
        totalQuestions: 2,
      });
      expect(Object.keys(res.body.data).sort()).toEqual(['id', 'result']);
      expect(JSON.stringify(res.body)).not.toContain('isCorrect');
      expect(
        await testDb().courseClassExam.count({
          where: { traineeId: trainee.id },
        }),
      ).toBe(1);
    });

    it('front atual: validate-student abre a sessão e o register com traineeId passa', async () => {
      const { turma, trainee } = await provaCenario();
      const v = await form('/classes/validate-student', {
        cpf: CPF,
        classCode: CODE,
        classId: turma.id,
      });
      expect(v.status).toBe(201);
      expect(v.body.traineeId).toBe(trainee.id);
      expect(JSON.stringify(v.body.exam)).not.toContain('isCorrect');
      await form('/exames/register', {
        traineeId: trainee.id,
        classId: turma.id,
        examResponses: wrong,
        companyId: 1,
      }).expect(201);
      // a sessão é de uso único
      await testDb().courseClassExam.deleteMany();
      await form('/exames/register', {
        traineeId: trainee.id,
        classId: turma.id,
        examResponses: wrong,
      }).expect(400);
    });
  });

  describe('N4 – rotas públicas sem upload', () => {
    const file = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );

    it('arquivo é recusado em validate-student, exames/register, create-review e subscribe', async () => {
      const { turma, trainee } = await provaCenario();
      const routes: Array<[string, Record<string, string | number>]> = [
        [
          '/classes/validate-student',
          { cpf: CPF, classCode: CODE, classId: turma.id },
        ],
        [
          '/exames/register',
          {
            classId: turma.id,
            cpf: CPF,
            classCode: CODE,
            examResponses: wrong,
          },
        ],
        [
          '/reviews/create-review',
          { traineeId: trainee.id, classId: turma.id, generalRating: 5 },
        ],
        [
          '/subscription/subscribe',
          {
            name: 'Maria',
            cpf: '39053344705',
            email: 'm@teste.local',
            phone: '81999998888',
            classId: turma.id,
          },
        ],
      ];
      for (const [url, fields] of routes) {
        const res = await form(url, fields).attach('image', file, {
          filename: 'x.svg',
          contentType: 'image/svg+xml',
        });
        expect([400, 413]).toContain(res.status);
      }
      expect(await testDb().courseClassExam.count()).toBe(0);
      expect(await testDb().courseReview.count()).toBe(0);
    });

    it('multipart só de campos continua funcionando (avaliação do front)', async () => {
      const { turma, trainee } = await provaCenario();
      await form('/reviews/create-review', {
        traineeId: trainee.id,
        classId: turma.id,
        companyId: 1,
        generalRating: 5,
        opinionRating: 'Ótimo',
        authorizationExposeReview: 'true',
      }).expect(201);
      expect(await testDb().courseReview.count()).toBe(1);
    });
  });

  describe('M3 – inscrição pública só em turma aberta', () => {
    const buyer = {
      name: 'Maria Souza',
      cpf: '39053344705',
      email: 'maria@teste.local',
      phone: '81999998888',
    };

    it('turma fechada (openClass=false) recusa; aberta aceita', async () => {
      const closed = await makeCheckoutScenario({
        openClass: false,
        allowCheckout: false,
        price: null,
      });
      await form('/subscription/subscribe', {
        ...buyer,
        classId: closed.courseClass.id,
      }).expect(400);
      const open = await makeCourseClass(closed.company.id, closed.course.id, {
        openClass: true,
        allowCheckout: false,
        price: null,
      });
      await form('/subscription/subscribe', {
        ...buyer,
        classId: open.id,
      }).expect(201);
      expect(await testDb().courseClassSubscription.count()).toBe(1);
    });
  });

  describe('N1 – vitrine de certificados', () => {
    async function certificado() {
      const { company, course, turma, trainee } = await provaCenario();
      const key = '3f1c2b9a-6d7e-4f80-9a1b-2c3d4e5f6a7b';
      await testDb().traineeCourseCertificate.create({
        data: {
          key,
          companyId: company.id,
          courseId: course.id,
          classId: turma.id,
          traineeId: trainee.id,
          showOnWebsiteConsent: true,
          fabricJsonFront: { objects: [] },
          variableToReplace: {
            aluno_nome: { type: 'string', value: 'ANA LIMA' },
            aluno_cpf: { type: 'string', value: CPF },
            aluno_data_nascimento: { type: 'string', value: '01/01/1990' },
            curso_nome: { type: 'string', value: 'NR-35' },
          },
        },
      });
      return { key, trainee };
    }

    it('lista pública não traz CPF nem nascimento, mas mantém nome e curso', async () => {
      await certificado();
      const res = await request(httpServer())
        .get('/trainee-certificate/public?show=trainee')
        .expect(200);
      expect(res.body.rows).toHaveLength(1);
      const vars = res.body.rows[0].variableToReplace;
      expect(vars.aluno_nome.value).toBe('ANA LIMA');
      expect(vars.curso_nome.value).toBe('NR-35');
      expect(vars.aluno_cpf).toBeUndefined();
      expect(vars.aluno_data_nascimento).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(CPF);
    });

    it('formato antigo (base64 de JSON) também é limpo', async () => {
      const { key } = await certificado();
      const encoded = Buffer.from(
        JSON.stringify({
          aluno_nome: { value: 'ANA' },
          aluno_cpf: { value: CPF },
        }),
      ).toString('base64');
      await testDb().traineeCourseCertificate.updateMany({
        where: { key },
        data: { variableToReplace: encoded },
      });
      const res = await request(httpServer())
        .get('/trainee-certificate/public')
        .expect(200);
      expect(res.body.rows[0].variableToReplace).toEqual({
        aluno_nome: { value: 'ANA' },
      });
    });

    it('filtro por CPF do aluno não é aceito', async () => {
      await certificado();
      const res = await request(httpServer()).get(
        `/trainee-certificate/public?trainee.cpf=${CPF}`,
      );
      expect(res.status).toBe(400);
    });

    it('verificação pelo código exato continua completa', async () => {
      const { key } = await certificado();
      const res = await request(httpServer())
        .get(`/trainee-certificate/public?key=${key}`)
        .expect(200);
      expect(res.body.rows[0].variableToReplace.aluno_cpf.value).toBe(CPF);
    });
  });
});
