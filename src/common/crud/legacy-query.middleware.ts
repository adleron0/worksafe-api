import type { NextFunction, Request, Response } from 'express';

/**
 * Compatibilidade com o formato antigo de OR, ainda usado pelo worksafe-site:
 *
 *   ?or=[{"gte-initialDate":"2026-11-11"},{"periodClass":"UNLIMITED"}]
 *
 * vira os grupos que o @adleron/crud-core entende:
 *
 *   ?or.0.gte-initialDate=2026-11-11&or.1.periodClass=UNLIMITED
 *
 * Cada objeto do array é uma alternativa (chaves dentro dele = AND), mesma
 * semântica do GenericService antigo. JSON inválido ou fora desse formato é
 * deixado como veio, e o parser recusa com 400 — nunca é avaliado.
 */
export function legacyOrQuery(req: Request, _res: Response, next: NextFunction) {
  const raw = (req.query as Record<string, unknown>)?.or;
  if (typeof raw !== 'string' || !raw.trim().startsWith('[')) return next();

  let groups: unknown;
  try {
    groups = JSON.parse(raw);
  } catch {
    return next();
  }
  if (!Array.isArray(groups) || !groups.every((g) => g && typeof g === 'object' && !Array.isArray(g))) {
    return next();
  }

  const query: Record<string, unknown> = { ...(req.query as Record<string, unknown>) };
  delete query.or;
  groups.forEach((group, index) => {
    for (const [key, value] of Object.entries(group as Record<string, unknown>)) {
      query[`or.${index}.${key}`] = Array.isArray(value) ? value.map(String) : String(value);
    }
  });
  // Express 5: req.query é um getter no protótipo; sobrescreve na instância.
  Object.defineProperty(req, 'query', { value: query, writable: true, configurable: true, enumerable: true });
  next();
}
