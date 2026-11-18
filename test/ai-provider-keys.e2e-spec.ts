import './setup/env'; // precisa ser o primeiro import

import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { encryptPayload } from 'src/utils/crypto';
import { ProviderKeyStore } from 'src/features/ai/providers/provider-keys.service';
import { bootTestApp, httpServer, shutdownTestApp, flushCache } from './setup/app';
import { resetDb, testDb } from './setup/db';
import { makeCompany, makeSeller } from './setup/factories';

/**
 * Chave do fornecedor de IA cadastrada pela tela: fica criptografada, vale antes
 * da variável do servidor, nunca volta inteira na resposta e, ao remover, volta
 * a valer a variável.
 */
describe('Bots — chaves dos fornecedores de IA (e2e)', () => {
  let jwt: JwtService;
  let store: ProviderKeyStore;
  const envBefore = process.env.GEMINI_API_KEY;

  beforeAll(async () => { const app = await bootTestApp(); jwt = app.get(JwtService); store = app.get(ProviderKeyStore); });
  afterAll(async () => { process.env.GEMINI_API_KEY = envBefore; await shutdownTestApp(); });
  beforeEach(async () => { await resetDb(); await flushCache(); await store.reload(); delete process.env.GEMINI_API_KEY; });

  const auth = (companyId: number, userId: number, permissions: string[]) => ({
    Authorization: `Bearer ${jwt.sign({ data: encryptPayload({ sub: userId, companyId, permissions, profile: 'super' }) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' })}`,
  });
  const api = () => request(httpServer());

  it('cadastra, mostra só o final, vale antes da variável e volta para ela ao remover', async () => {
    const company = await makeCompany();
    const user = await makeSeller(company.id);
    const headers = auth(company.id, user.id, ['chaves_ia_bots', 'update_bots', 'usar_bots']);
    const key = 'AIzaChaveDeTeste_0123456789wxyz';

    process.env.GEMINI_API_KEY = 'chave-da-variavel-do-servidor';
    let list = (await api().get('/ai/provider-keys').set(headers).expect(200)).body;
    expect(list.find((row: any) => row.provider === 'gemini')).toMatchObject({ source: 'servidor', hint: null, envName: 'GEMINI_API_KEY', label: 'Google Gemini' });

    const saved = (await api().put('/ai/provider-keys/gemini').set(headers).send({ key: `  ${key}  ` }).expect(200)).body;
    expect(saved).toMatchObject({ provider: 'gemini', source: 'tela', hint: '…wxyz' });
    expect(store.key('gemini')).toBe(key);
    const row = await testDb().ai_ProviderKey.findUnique({ where: { provider: 'gemini' } });
    expect(row!.keyEncrypted).not.toContain(key);
    expect(row!.updatedByUserId).toBe(user.id);

    list = (await api().get('/ai/provider-keys').set(headers).expect(200)).body;
    expect(JSON.stringify(list)).not.toContain(key);
    const status = (await api().get('/ai/status').set(headers).expect(200)).body;
    expect(status.providers.find((item: any) => item.id === 'gemini').available).toBe(true);

    // trocar a chave substitui a anterior
    await api().put('/ai/provider-keys/gemini').set(headers).send({ key: 'AIzaOutraChave_9876543210abcd' }).expect(200);
    expect(store.key('gemini')).toBe('AIzaOutraChave_9876543210abcd');
    expect(await testDb().ai_ProviderKey.count()).toBe(1);

    const removed = (await api().delete('/ai/provider-keys/gemini').set(headers).expect(200)).body;
    expect(removed).toMatchObject({ source: 'servidor', hint: null });
    expect(store.key('gemini')).toBe('chave-da-variavel-do-servidor');

    delete process.env.GEMINI_API_KEY;
    expect((await api().get('/ai/provider-keys').set(headers).expect(200)).body.find((item: any) => item.provider === 'gemini').source).toBeNull();
    expect((await api().get('/ai/status').set(headers).expect(200)).body.providers.find((item: any) => item.id === 'gemini').available).toBe(false);
  });

  it('valida a chave e o fornecedor e exige a permissão', async () => {
    const company = await makeCompany();
    const user = await makeSeller(company.id);
    const headers = auth(company.id, user.id, ['chaves_ia_bots']);
    await api().put('/ai/provider-keys/gemini').set(headers).send({ key: 'curta' }).expect(400);
    await api().put('/ai/provider-keys/gemini').set(headers).send({ key: 'AIza com espaco no meio 123' }).expect(400);
    await api().put('/ai/provider-keys/gemini').set(headers).send({}).expect(400);
    await api().put('/ai/provider-keys/fake').set(headers).send({ key: 'AIzaChaveDeTeste_0123456789' }).expect(400);
    await api().delete('/ai/provider-keys/inexistente').set(headers).expect(400);

    const semPermissao = auth(company.id, user.id, ['update_bots', 'usar_bots']);
    await api().get('/ai/provider-keys').set(semPermissao).expect(403);
    await api().put('/ai/provider-keys/gemini').set(semPermissao).send({ key: 'AIzaChaveDeTeste_0123456789' }).expect(403);
    await api().delete('/ai/provider-keys/gemini').set(semPermissao).expect(403);
  });
});
