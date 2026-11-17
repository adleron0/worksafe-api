import { BadRequestException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Proteção da inscrição pública contra robôs, sem pedir nada à pessoa:
 *
 * - campo-isca (`website`): fica escondido no formulário; só robô preenche;
 * - tempo mínimo (`formStartedAt`): envio menos de 3 s depois de a página
 *   abrir não é gente digitando;
 * - Cloudflare Turnstile (opcional): ligado quando existe
 *   TURNSTILE_SECRET_KEY. O site resolve o desafio (normalmente invisível),
 *   troca o token por um passe nosso em /subscription/human-check e manda o
 *   passe em cada envio. O passe vale 1 hora porque o checkout chama o
 *   subscribe mais de uma vez (troca de PIX para boleto, nova tentativa de
 *   cartão) e o token do Turnstile só pode ser usado uma vez.
 *
 * Os campos de controle nunca chegam ao banco.
 */
export const ANTI_BOT_FIELDS = ['website', 'formStartedAt', 'humanPass', 'turnstileToken'] as const;

export const MIN_FILL_MS = 3000;
const PASS_TTL_MS = 60 * 60 * 1000;
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const GENERIC_ERROR = 'Não foi possível concluir a inscrição. Recarregue a página e tente novamente.';

export const turnstileEnabled = () => !!process.env.TURNSTILE_SECRET_KEY;

const sign = (value: string) =>
  createHmac('sha256', `human-pass:${process.env.TURNSTILE_SECRET_KEY}`).update(value).digest('hex');

export function issueHumanPass(now = Date.now()): string {
  const exp = String(now + PASS_TTL_MS);
  return `${exp}.${sign(exp)}`;
}

export function isValidHumanPass(pass: unknown, now = Date.now()): boolean {
  if (typeof pass !== 'string' || !turnstileEnabled()) return false;
  const [exp, mac] = pass.split('.');
  if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) < now) return false;
  const expected = Buffer.from(sign(exp));
  const received = Buffer.from(mac);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * Confere o token do Turnstile com a Cloudflare. Se a Cloudflare não
 * responder, deixa passar: uma queda dela não pode parar as vendas.
 */
export async function verifyTurnstile(token: unknown, ip?: string): Promise<boolean> {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const body = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY || '', response: token });
  if (ip) body.set('remoteip', ip);
  try {
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(8000) });
    const data: any = await res.json();
    if (data?.success !== true) console.warn('[anti-bot] Turnstile recusou o token:', data?.['error-codes']);
    return data?.success === true;
  } catch (err) {
    console.error('[anti-bot] Turnstile indisponível, liberando:', (err as Error)?.message);
    return true;
  }
}

/**
 * Barra o envio de robô e remove os campos de controle do corpo. Os campos
 * são opcionais (clientes antigos e testes continuam funcionando); o passe só
 * é exigido com o Turnstile ligado.
 */
export function checkHuman(body: Record<string, any>, now = Date.now()) {
  const honeypot = body.website;
  const startedAt = Number(body.formStartedAt);
  const pass = body.humanPass;
  for (const field of ANTI_BOT_FIELDS) delete body[field];

  if (typeof honeypot === 'string' && honeypot.trim() !== '') {
    console.warn('[anti-bot] campo-isca preenchido, inscrição recusada');
    throw new BadRequestException(GENERIC_ERROR);
  }
  if (Number.isFinite(startedAt) && startedAt > 0 && now - startedAt < MIN_FILL_MS) {
    console.warn('[anti-bot] envio rápido demais, inscrição recusada');
    throw new BadRequestException(GENERIC_ERROR);
  }
  if (turnstileEnabled() && !isValidHumanPass(pass, now)) {
    throw new BadRequestException('A verificação de segurança expirou. Recarregue a página e tente novamente.');
  }
}
