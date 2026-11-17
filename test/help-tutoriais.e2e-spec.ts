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
import { makeCompany, makeSeller } from './setup/factories';
import { blockRealNetwork, resetAsaasMock } from './setup/asaas-mock';

/**
 * Central de ajuda (/help): treinos concluídos e registro de uso.
 *
 * O que não pode quebrar: cada pessoa só lê e grava o próprio estado; evento
 * inválido nunca derruba a tela (é descartado).
 */
describe('Central de ajuda (e2e)', () => {
  let jwt: JwtService;

  beforeAll(async () => {
    blockRealNetwork();
    const app = await bootTestApp();
    jwt = app.get(JwtService);
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

  const auth = (
    companyId: number,
    sub: number,
    permissions: string[] = [],
  ) => ({
    Authorization: `Bearer ${jwt.sign(
      {
        data: encryptPayload({ sub, companyId, permissions, profile: 'admin' }),
      },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
    )}`,
  });
  const api = () => request(httpServer());

  it('guarda concluído e dispensado por pessoa, e zerar limpa o registro', async () => {
    const company = await makeCompany();
    const ana = await makeSeller(company.id);
    const bia = await makeSeller(company.id);

    expect(
      (await api().get('/help/state').set(auth(company.id, ana.id)).expect(200))
        .body,
    ).toEqual({ tours: {} });

    await api()
      .put('/help/state/comercial.propostas')
      .set(auth(company.id, ana.id))
      .send({ action: 'complete' })
      .expect(200);
    await api()
      .put('/help/state/comercial.receber-proposta')
      .set(auth(company.id, ana.id))
      .send({ action: 'dismiss' })
      .expect(200);

    const mine = (
      await api().get('/help/state').set(auth(company.id, ana.id)).expect(200)
    ).body.tours;
    expect(mine['comercial.propostas'].completedAt).toBeTruthy();
    expect(mine['comercial.propostas'].dismissedAt).toBeNull();
    expect(mine['comercial.receber-proposta'].dismissedAt).toBeTruthy();

    // a outra pessoa não enxerga nada disso
    expect(
      (await api().get('/help/state').set(auth(company.id, bia.id)).expect(200))
        .body,
    ).toEqual({ tours: {} });

    const reset = (
      await api()
        .put('/help/state/comercial.propostas')
        .set(auth(company.id, ana.id))
        .send({ action: 'reset' })
        .expect(200)
    ).body;
    expect(reset.completedAt).toBeNull();
    expect(reset.dismissedAt).toBeNull();
    // gravar de novo não duplica a linha
    await api()
      .put('/help/state/comercial.propostas')
      .set(auth(company.id, ana.id))
      .send({ action: 'complete' })
      .expect(200);
    expect(await testDb().help_State.count({ where: { userId: ana.id } })).toBe(
      2,
    );
  });

  it('recusa treino ou ação inválidos e exige login', async () => {
    const company = await makeCompany();
    const ana = await makeSeller(company.id);
    await api()
      .put('/help/state/Tour%20Ruim')
      .set(auth(company.id, ana.id))
      .send({ action: 'complete' })
      .expect(400);
    await api()
      .put('/help/state/comercial.propostas')
      .set(auth(company.id, ana.id))
      .send({ action: 'apagar' })
      .expect(400);
    await api().get('/help/state').expect(401);
    await api()
      .post('/help/events')
      .send({ events: [{ event: 'lesson_start' }] })
      .expect(401);
  });

  it('eventos: grava os válidos com empresa e pessoa do token e descarta o resto', async () => {
    const company = await makeCompany();
    const ana = await makeSeller(company.id);
    const res = await api()
      .post('/help/events')
      .set(auth(company.id, ana.id))
      .send({
        events: [
          {
            event: 'lesson_start',
            tourId: 'comercial.propostas',
            route: '/comercial/propostas',
          },
          {
            event: 'chapter_jump',
            tourId: 'comercial.propostas',
            step: 2,
            target: 'nova',
          },
          { event: 'inventado', tourId: 'comercial.propostas' },
          { event: 'lesson_exit', tourId: 'NÃO VALE', step: -3 },
          null,
          {
            event: 'video_play',
            tourId: 'comercial.propostas',
            target: 'x'.repeat(500),
          },
        ],
      })
      .expect(200);
    expect(res.body).toEqual({ recorded: 4 });

    const rows = await testDb().help_Event.findMany({ orderBy: { id: 'asc' } });
    expect(rows.map((row) => row.event)).toEqual([
      'lesson_start',
      'chapter_jump',
      'lesson_exit',
      'video_play',
    ]);
    expect(
      rows.every(
        (row) => row.companyId === company.id && row.userId === ana.id,
      ),
    ).toBe(true);
    expect(rows[1].step).toBe(2);
    expect(rows[2].tourId).toBeNull(); // id inválido vira vazio, o evento fica
    expect(rows[2].step).toBeNull();
    expect(rows[3].target).toHaveLength(120);

    // corpo torto não derruba nada
    expect(
      (
        await api()
          .post('/help/events')
          .set(auth(company.id, ana.id))
          .send({ events: 'x' })
          .expect(200)
      ).body,
    ).toEqual({ recorded: 0 });
  });
});
