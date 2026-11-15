import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { AIService } from 'src/common/ai';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Divulgação de turmas (arte e legenda).
 *
 * O que não pode quebrar: na primeira vez a empresa ganha as configurações
 * (com os contatos do cadastro) e os modelos de legenda padrão, sem duplicar;
 * as configurações só guardam campos conhecidos; os modelos são da empresa;
 * a IA só recebe a legenda pronta e volta texto limpo; e cada ação pede a
 * sua permissão.
 */
describe('Divulgação de turmas (e2e)', () => {
  const ALL = ['list_divulgacao', 'update_divulgacao'];
  let jwt: JwtService;
  let ai: AIService;

  beforeAll(async () => {
    const app = await bootTestApp();
    jwt = app.get(JwtService);
    ai = app.get(AIService);
  });
  afterAll(async () => { await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); jest.restoreAllMocks(); });

  let userId = 0;
  const auth = (companyId: number, permissions: string[] = ALL) => ({
    Authorization: `Bearer ${jwt.sign(
      { data: encryptPayload({ sub: userId, companyId, permissions, profile: 'admin' }) },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
    )}`,
  });
  const api = () => request(httpServer());

  it('primeiro acesso cria configurações com os contatos da empresa e os 5 modelos, uma vez só', async () => {
    const company = await makeCompany({ operational_contact: '(81) 98947-9259', operational_email: 'treinamentos@empresa.com.br', lp_domain: 'empresa.com.br' });

    const first = await api().get('/marketing/settings').set(auth(company.id)).expect(200);
    expect(first.body.settings).toMatchObject({
      whatsapp: '(81) 98947-9259',
      email: 'treinamentos@empresa.com.br',
      site: 'https://empresa.com.br',
      linkInscricao: 'turma',
      ultimasVagasLimite: 5,
    });
    expect(first.body.settings.localPadrao).toContain(company.comercial_name);

    await api().get('/marketing/settings').set(auth(company.id)).expect(200);
    const captions = await testDb().marketing_CaptionTemplate.findMany({ where: { companyId: company.id } });
    expect(captions.map((c) => c.kind).sort()).toEqual(['curso_rapido', 'promocao', 'story', 'turma_nova', 'ultimas_vagas']);
  });

  it('salvar configurações ignora campos desconhecidos e normaliza listas', async () => {
    const company = await makeCompany();
    const res = await api().put('/marketing/settings').set(auth(company.id)).send({
      whatsapp: ' (81) 90000-0000 ',
      inclusoPadrao: 'Alojamento\n\n Camisa ',
      linkInscricao: 'qualquer',
      hashtagsPorCurso: { 3: '#nr35', abc: '#x', 4: '' },
      ultimasVagasLimite: 500,
      hacker: 'x',
    }).expect(200);
    expect(res.body.settings).toMatchObject({
      whatsapp: '(81) 90000-0000',
      inclusoPadrao: ['Alojamento', 'Camisa'],
      linkInscricao: 'turma',
      hashtagsPorCurso: { 3: '#nr35' },
      ultimasVagasLimite: 100,
    });
    const row = await testDb().marketing_Setting.findUnique({ where: { companyId: company.id } });
    expect(row?.data).not.toHaveProperty('hacker');
  });

  it('modelos de legenda são da empresa, validam texto e voltam com "recriar padrão"', async () => {
    const a = await makeCompany();
    const b = await makeCompany();
    userId = (await makeSeller(a.id, { isSeller: false })).id; // o log de auditoria pede usuário real
    await api().get('/marketing/settings').set(auth(a.id)).expect(200);

    await api().post('/marketing-captions').set(auth(a.id)).send({ name: 'Vazio', body: '   ' }).expect(400);
    const created = await api().post('/marketing-captions').set(auth(a.id))
      .send({ name: '  Black Friday ', kind: 'inexistente', body: 'Turma {{curso}}\r\nem {{datas}}' }).expect(201);
    expect(created.body).toMatchObject({ name: 'Black Friday', kind: 'outro', body: 'Turma {{curso}}\nem {{datas}}' });

    const listB = await api().get('/marketing-captions').set(auth(b.id)).query({ limit: 50 }).expect(200);
    expect(listB.body.rows).toHaveLength(0);

    const padrao = await testDb().marketing_CaptionTemplate.findFirst({ where: { companyId: a.id, name: 'Turma nova' } });
    await api().patch(`/marketing-captions/inactive/${padrao!.id}`).set(auth(a.id)).expect(200);
    const restored = await api().post('/marketing/captions/restore-defaults').set(auth(a.id)).expect(200);
    expect(restored.body).toEqual({ created: 1 });
    const again = await api().post('/marketing/captions/restore-defaults').set(auth(a.id)).expect(200);
    expect(again.body).toEqual({ created: 0 });
  });

  it('IA recebe a legenda pronta e devolve texto limpo; falha vira 503', async () => {
    const company = await makeCompany();
    const spy = jest.spyOn(ai, 'generateContent').mockResolvedValue('"""\n🚨 Turma nova  \n\n\n\nR$ 150,00   \n"""');
    const res = await api().post('/marketing/captions/ai').set(auth(company.id))
      .send({ caption: '🚨 ABERTAS AS VAGAS PARA NR-35\n💰 R$ 150,00', style: 'curto' }).expect(200);
    expect(res.body.caption).toBe('🚨 Turma nova\n\nR$ 150,00');
    expect(spy.mock.calls[0][0]).toContain('R$ 150,00');
    expect(spy.mock.calls[0][0]).toContain('mais curto');

    await api().post('/marketing/captions/ai').set(auth(company.id)).send({ caption: 'curta' }).expect(400);
    spy.mockRejectedValue(new Error('fora do ar'));
    await api().post('/marketing/captions/ai').set(auth(company.id))
      .send({ caption: 'Legenda com mais de vinte caracteres' }).expect(503);
  });

  it('cada ação pede a sua permissão', async () => {
    const company = await makeCompany();
    await api().get('/marketing/settings').set(auth(company.id, [])).expect(403);
    await api().get('/marketing/settings').set(auth(company.id, ['list_divulgacao'])).expect(200);
    await api().put('/marketing/settings').set(auth(company.id, ['list_divulgacao'])).send({ whatsapp: 'x' }).expect(403);
    await api().post('/marketing-captions').set(auth(company.id, ['list_divulgacao'])).send({ name: 'X', body: 'y' }).expect(403);
    await api().post('/marketing/captions/restore-defaults').set(auth(company.id, ['list_divulgacao'])).expect(403);
  });
});
