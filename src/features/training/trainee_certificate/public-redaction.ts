/**
 * Vitrine pública de certificados (GET /trainee-certificate/public).
 *
 * `variableToReplace` carrega o que vai impresso no certificado — inclusive
 * CPF e data de nascimento. Na listagem (vitrine e página do profissional) o
 * front só lê nome, curso, turma, código e emissão; o CPF de todo certificado
 * autorizado saía numa única chamada. Aqui ficam de fora os dados pessoais
 * que a vitrine não usa.
 *
 * A verificação por código (`?key=<uuid exato>`) continua completa: é o
 * documento que o aluno entrega a quem quiser, e a página desenha o
 * certificado com essas variáveis quando a imagem do servidor falha.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Variáveis pessoais que nunca saem na listagem pública. */
export const PRIVATE_CERTIFICATE_VARIABLES = [
  'aluno_cpf',
  'aluno_data_nascimento',
];

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

export function redactCertificateVariables(
  value: unknown,
): Record<string, unknown> | null {
  const variables = parseVariables(value);
  if (!variables) return null;
  for (const key of PRIVATE_CERTIFICATE_VARIABLES) delete variables[key];
  return variables;
}

export function isExactKeyLookup(
  query: Record<string, unknown> | undefined,
): boolean {
  return typeof query?.key === 'string' && UUID.test(query.key);
}

/** Aplica a redação às linhas da listagem pública (fora da busca por código). */
export function redactPublicCertificates<T>(
  result: T,
  query: Record<string, unknown> | undefined,
): T {
  if (isExactKeyLookup(query)) return result;
  const rows = (result as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return result;
  for (const row of rows as Array<Record<string, unknown>>) {
    if (row && 'variableToReplace' in row)
      row.variableToReplace = redactCertificateVariables(row.variableToReplace);
  }
  return result;
}
