import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import { AppModule } from '../../src/app.module';
import { CacheService } from '../../src/common/cache/cache.service';
import { legacyOrQuery } from '../../src/common/crud/legacy-query.middleware';
import { closeDb } from './db';

let app: INestApplication | null = null;

/**
 * Sobe a aplicação uma única vez por arquivo de teste.
 *
 * Test.createTestingModule NÃO executa o bootstrap de main.ts, então o
 * cookie-parser precisa ser aplicado aqui (o refresh token vem por cookie).
 * Os rate limiters de main.ts ficam de fora de propósito — ver R7.
 */
export async function bootTestApp(): Promise<INestApplication> {
  if (app) return app;

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.use(legacyOrQuery); // como em main.ts
  await app.init();
  // Escuta uma vez, só em 127.0.0.1. Sem isto o supertest abre uma porta nova em
  // todos os endereços a cada requisição e conecta em 127.0.0.1: se outro programa
  // da máquina estiver ouvindo aquela porta nesse endereço, a resposta vem dele
  // (404 de rota que existe, "Parse Error: Expected HTTP/") e o teste falha sem motivo.
  await app.listen(0, '127.0.0.1');
  return app;
}

export function httpServer() {
  if (!app) throw new Error('bootTestApp() precisa ser chamado antes');
  return app.getHttpServer();
}

/** Limpa o Redis entre testes: o CacheService é singleton estático e vaza estado. */
export async function flushCache(): Promise<void> {
  try {
    await new CacheService().reset();
  } catch {
    /* Redis fora do ar não deve derrubar o teardown */
  }
}

export async function shutdownTestApp(): Promise<void> {
  await flushCache();
  if (app) {
    await app.close();
    app = null;
  }
  await closeDb();
}
