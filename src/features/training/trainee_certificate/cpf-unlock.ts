import { createHmac, timingSafeEqual } from 'crypto';

/**
 * CPF no certificado público (LGPD).
 *
 * Por padrão a página pública, a imagem e o PDF saem com os CPFs mascarados
 * (`***.***.789-**`) e sem data de nascimento. O certificado completo — CPF
 * do aluno E dos instrutores, que assinam como responsáveis — aparece para:
 *
 * - quem leu o QR Code do certificado: o link leva `?u=<selo>`;
 * - quem digitou o CPF do aluno corretamente (POST /public/:key/unlock);
 * - o próprio aluno (portal) e a empresa logada (GET /unlock/:key).
 *
 * O selo é um HMAC da chave do certificado com um segredo só do servidor:
 * não dá para adivinhar a partir da chave (que aparece na vitrine do site).
 */

function secret(): string {
  return (
    process.env.CERT_UNLOCK_SECRET ||
    process.env.JWT_ACCESS_SECRET ||
    'dev-only-cert-unlock-secret'
  );
}

export function certificateUnlockToken(key: string): string {
  return createHmac('sha256', secret())
    .update(`cert-unlock:${String(key).toLowerCase()}`)
    .digest('base64url')
    .slice(0, 22);
}

export function isValidUnlockToken(key: string, token: unknown): boolean {
  if (typeof token !== 'string' || token.length !== 22) return false;
  const expected = Buffer.from(certificateUnlockToken(key));
  const received = Buffer.from(token);
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

/** Variável com CPF (aluno_cpf, instrutor_cpf, instrutor_cpf_2...). */
export const isCpfVariable = (name: string) => /cpf/i.test(name);
/** Variável com data de nascimento. */
export const isBirthVariable = (name: string) => /nascimento/i.test(name);

/** `123.456.789-09` → `***.***.789-**` (só 3 dígitos do meio à vista). */
export function maskCpf(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length !== 11) return digits ? '***.***.***-**' : '';
  return `***.***.${digits.slice(6, 9)}-**`;
}

export const onlyDigits = (value: unknown) =>
  String(value ?? '').replace(/\D/g, '');

/**
 * Cópia das variáveis com CPFs mascarados e nascimento escondido. Aceita o
 * formato `{ nome: { type, value } }` e valores soltos.
 */
export function maskCertificateVariables<T extends Record<string, any>>(
  variables: T,
): T {
  const out: Record<string, any> = { ...variables };
  for (const name of Object.keys(out)) {
    const masker = isCpfVariable(name)
      ? maskCpf
      : isBirthVariable(name)
        ? () => '**/**/****'
        : null;
    if (!masker) continue;
    const entry = out[name];
    if (entry && typeof entry === 'object' && 'value' in entry) {
      out[name] = {
        ...entry,
        value: entry.value ? masker(entry.value) : entry.value,
      };
    } else if (entry) {
      out[name] = masker(entry);
    }
  }
  return out as T;
}
