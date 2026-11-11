/**
 * Carrega .env.test ANTES de qualquer import que leia process.env.
 * Precisa ser o primeiro import de todo arquivo .e2e-spec.ts.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({
  path: path.resolve(__dirname, '../../.env.test'),
  override: true,
});

// Guarda-chuva: se alguém rodar a suíte com um .env de produção carregado,
// o banco de teste é o único destino aceitável.
const uri = process.env.DATABASE_URI || '';
if (!uri.includes('worksafe_test')) {
  throw new Error(
    `Suíte e2e abortada: DATABASE_URI não aponta para o banco de teste.\n` +
      `Recebido: ${uri.replace(/:\/\/.*@/, '://***@')}`,
  );
}
