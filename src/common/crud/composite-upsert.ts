import { CrudService, EntityDefinition } from '@adleron/crud-core';
import { Request } from 'express';

/**
 * Upsert por chave composta SEM constraint unique no schema (ex.: presença por
 * classId+traineeId+day). O núcleo só aceita upsertKey único — aqui é
 * find-then-write pelo CrudService, então escopo, permissão e auditoria
 * continuam valendo. Não é atômico: aceito para as duas entidades que usam.
 */
export async function compositeUpsert(
  crud: CrudService<Request>,
  def: EntityDefinition,
  keys: string[],
  body: Record<string, unknown>,
  request: Request,
) {
  const query: Record<string, string> = { limit: '1' };
  for (const key of keys) {
    if (body[key] === undefined || body[key] === null || body[key] === '') {
      throw new Error(`Campo '${key}' é obrigatório no upsert`);
    }
    query[key] = String(body[key]);
  }
  const { rows } = await crud.list(def, query, request);
  const existing = rows[0];
  return existing
    ? crud.update(def, existing[def.idField], body, request)
    : crud.create(def, body, request);
}
