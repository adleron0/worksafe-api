import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import { AppModule } from '../../src/app.module';
import { CacheService } from '../../src/common/cache/cache.service';
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
  await app.init();
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
