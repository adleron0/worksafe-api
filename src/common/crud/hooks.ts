import { EntityHooks } from '@adleron/crud-core';
import { hash } from 'bcrypt';
import { Request } from 'express';

import { UploadService } from 'src/features/upload/upload.service';

const uploadService = new UploadService();

/**
 * Entidades com `active` (boolean) E `inactiveAt` (data): o changeStatus do
 * generic antigo mantinha os dois em sincronia. Aqui vira hook explícito.
 */
export const syncActiveFlag: EntityHooks<Request> = {
  preWrite: ({ op, data }) => {
    if (op === 'archive') return { ...data, active: false };
    if (op === 'restore') return { ...data, active: true };
    return undefined;
  },
};

/**
 * Upload via multipart: mapa `fieldname do arquivo → coluna` (ex.:
 * `{ image: 'imageUrl', signature: 'signatureUrl' }`). O arquivo já está no
 * S3 quando o hook roda; grava a URL e apaga a anterior ao substituir ou ao
 * enviar `null` para a coluna. Concern do projeto — o núcleo não sabe o que é S3.
 */
export function fileUpload(map: Record<string, string>): EntityHooks<Request> {
  return {
    preWrite: async ({ context, op, data, existing }) => {
      const file = (context as Request & { file?: Express.MulterS3.File }).file;
      let patched = data;
      if (file?.location && map[file.fieldname]) {
        const column = map[file.fieldname];
        const previous = existing?.[column] as string | undefined;
        if (previous && op !== 'create') await uploadService.deleteImageFromS3(previous);
        patched = { ...patched, [column]: file.location };
      }
      for (const column of Object.values(map)) {
        const previous = existing?.[column] as string | undefined;
        if (patched[column] === null && previous && !(file?.location && map[file.fieldname] === column)) {
          await uploadService.deleteImageFromS3(previous);
        }
      }
      return patched;
    },
  };
}

export const imageUpload = (field = 'imageUrl'): EntityHooks<Request> => fileUpload({ image: field });

/** `password` nunca é gravada em claro: bcrypt em qualquer escrita que a traga. */
export const hashPassword: EntityHooks<Request> = {
  preWrite: async ({ data }) => {
    if (typeof data.password !== 'string' || data.password === '') {
      const { password: _omit, ...rest } = data;
      return rest;
    }
    return { ...data, password: await hash(data.password, 10) };
  },
};

/** Campos JSON que o form manda como string. */
export const parseJsonFields = (...fields: string[]): EntityHooks<Request> => ({
  preWrite: ({ data }) => {
    const patched = { ...data };
    for (const field of fields) {
      const value = patched[field];
      if (value === '' || value === 'undefined') delete patched[field];
      else if (typeof value === 'string') {
        try { patched[field] = JSON.parse(value); } catch { delete patched[field]; }
      }
    }
    return patched;
  },
});

/** Data só com dia (YYYY-MM-DD) vira ISO completo. */
export const normalizeDateOnly = (...fields: string[]): EntityHooks<Request> => ({
  preWrite: ({ data }) => {
    const patched = { ...data };
    for (const field of fields) {
      const value = patched[field];
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) patched[field] = `${value}T00:00:00.000Z`;
      if (value === '') patched[field] = null;
    }
    return patched;
  },
});
