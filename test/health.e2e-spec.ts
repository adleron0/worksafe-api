import './setup/env'; // precisa ser o primeiro import
import * as request from 'supertest';
import { bootTestApp, httpServer, shutdownTestApp } from './setup/app';

describe('GET /health', () => {
  beforeAll(async () => { await bootTestApp(); });
  afterAll(async () => { await shutdownTestApp(); });
  it('responde sem login', async () => {
    expect((await request(httpServer()).get('/health').expect(200)).body).toEqual({ ok: true });
  });
});
