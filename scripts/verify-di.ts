// Sobe SÓ a injeção de dependências do Nest (sem banco, sem porta): pega
// provider faltando, módulo não importado e erro de ordem de import.
import 'tsconfig-paths/register';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';

process.env.DATABASE_URL ||= 'postgresql://x:x@127.0.0.1:1/x';
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 90000);

NestFactory.create(AppModule, { logger: ['error'] })
  .then(() => { console.log('✔ DI OK'); process.exit(0); })
  .catch((error) => { console.error('✖ BOOT:', error?.message ?? error); process.exit(1); });
