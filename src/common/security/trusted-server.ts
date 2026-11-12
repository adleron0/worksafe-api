import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

/**
 * O site público (worksafe-site) monta páginas no servidor da Vercel: essas
 * chamadas chegam à API com o IP da Vercel, compartilhado por TODOS os
 * visitantes — por IP, eles dividiriam o mesmo limite de requisições.
 *
 * O servidor do site se identifica com o header `x-site-key` (segredo em
 * SITE_SERVER_KEY, nos dois lados) e fica fora do rate limit por IP.
 * Sem a env, nada muda. O navegador nunca recebe o segredo.
 */
export function isTrustedServerRequest(req: Request): boolean {
  const expected = process.env.SITE_SERVER_KEY;
  if (!expected || expected.length < 32) return false;
  const received = req.headers['x-site-key'];
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}
