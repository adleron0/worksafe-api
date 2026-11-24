import { timingSafeEqual } from 'crypto';
import { isIP } from 'net';
import { Request } from 'express';

/**
 * IP real de quem acessa.
 *
 * O sistema chama a API pelo proxy (proxy.worksafebrasil.com.br), que repassa
 * pela internet: no caminho, o Railway troca o X-Forwarded-For pelo IP do
 * próprio proxy, e todo mundo parecia vir do mesmo IP. Um ataque que passasse
 * pelo proxy bloqueava a empresa inteira (24/11/2026).
 *
 * Por isso o proxy manda o IP do cliente em `x-ws-client-ip`, assinado com
 * `x-ws-proxy-key` (segredo WS_PROXY_KEY nos dois serviços). Sem a chave certa,
 * vale o caminho de antes: primeiro X-Forwarded-For, X-Real-IP, IP da conexão.
 */
export function isTrustedProxyRequest(req: Request): boolean {
  const expected = process.env.WS_PROXY_KEY;
  if (!expected || expected.length < 32) return false;
  const received = req.headers['x-ws-proxy-key'];
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

export function clientIpOf(req: Request): string {
  if (isTrustedProxyRequest(req)) {
    const fromProxy = String(req.headers['x-ws-client-ip'] ?? '').trim();
    if (isIP(fromProxy)) return fromProxy;
  }
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (first) {
    const ip = String(first).split(',')[0].trim();
    if (ip) return ip;
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp) return realIp;
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
