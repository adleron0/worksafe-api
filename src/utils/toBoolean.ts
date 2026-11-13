/**
 * Booleano vindo de FormData/query (chega como string). Só "true", "1",
 * "on" e true/1 viram true — "false", "0", "" e o resto viram false.
 */
export function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    return ['true', '1', 'on'].includes(value.trim().toLowerCase());
  }
  return false;
}
