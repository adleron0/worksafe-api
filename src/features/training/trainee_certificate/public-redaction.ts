/**
 * Vitrine pública de certificados (GET /trainee-certificate/public).
 *
 * `variableToReplace` carrega o que vai impresso no certificado — inclusive
 * CPF e data de nascimento. Na listagem (vitrine e página do profissional) o
 * front só lê nome, curso, turma, código e emissão; o CPF de todo certificado
 * autorizado saía numa única chamada. Aqui ficam de fora os dados pessoais
 * que a vitrine não usa.
 *
 * Também a página do certificado (`?key=<uuid>`) sai mascarada, a menos que
 * venha com o selo `u` (QR Code, CPF digitado ou portal) — ver cpf-unlock.ts.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import { isValidUnlockToken, maskCertificateVariables } from './cpf-unlock';

/** Objeto, JSON ou base64 de JSON (formato antigo) → objeto; ilegível → null. */
function parseVariables(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return { ...(value as Record<string, unknown>) };
  if (typeof value !== 'string') return null;
  for (const text of [value, Buffer.from(value, 'base64').toString('utf8')]) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed;
    } catch {
      /* tenta o próximo formato */
    }
  }
  return null;
}

/** CPFs (aluno e instrutores) mascarados e nascimento escondido. */
export function redactCertificateVariables(
  value: unknown,
): Record<string, unknown> | null {
  const variables = parseVariables(value);
  if (!variables) return null;
  return maskCertificateVariables(variables);
}

export function isExactKeyLookup(
  query: Record<string, unknown> | undefined,
): boolean {
  return typeof query?.key === 'string' && UUID.test(query.key);
}

/**
 * Aplica a máscara às linhas da listagem pública. Só a busca pelo código
 * exato com o selo válido (`?key=<uuid>&u=<selo>` — veio do QR Code, do CPF
 * digitado ou do portal) devolve o certificado completo.
 */
export function redactPublicCertificates<T>(
  result: T,
  query: Record<string, unknown> | undefined,
): T {
  if (
    isExactKeyLookup(query) &&
    isValidUnlockToken(String(query!.key), query!.u)
  )
    return result;
  const rows = (result as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return result;
  for (const row of rows as Array<Record<string, unknown>>) {
    if (row && 'variableToReplace' in row)
      row.variableToReplace = redactCertificateVariables(row.variableToReplace);
  }
  return result;
}
