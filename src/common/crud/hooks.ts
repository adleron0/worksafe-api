import { EntityHooks } from '@adleron/crud-core';
import { hash } from 'bcrypt';
import { Request } from 'express';

import { UploadService } from 'src/features/upload/upload.service';

const uploadService = new UploadService();

/**
 * Entidades com `active` (boolean) E `inactiveAt` (data): o changeStatus do
 * generic antigo mantinha os dois em sincronia. Aqui vira hook explícito.
 */
export const syncFlag = (field = 'active'): EntityHooks<Request> => ({
  preWrite: ({ op, data }) => {
    if (op === 'archive') return { ...data, [field]: false };
    if (op === 'restore') return { ...data, [field]: true };
    return undefined;
  },
});
export const syncActiveFlag = syncFlag('active');

/**
 * Upload via multipart: mapa `fieldname do arquivo → coluna` (ex.:
 * `{ image: 'imageUrl', signature: 'signatureUrl' }`). O arquivo já está no
 * S3 quando o hook roda; grava a URL e apaga a anterior ao substituir ou ao
 * enviar `null` para a coluna. Concern do projeto — o núcleo não sabe o que é S3.
 */
export function fileUpload(map: Record<string, string>): EntityHooks<Request> {
  return {
    preWrite: async ({ context, op, data, existing }) => {
      const req = context as Request & {
        file?: Express.MulterS3.File;
        files?: Record<string, Express.MulterS3.File[]> | Express.MulterS3.File[];
      };
      // FileInterceptor → req.file; FileFieldsInterceptor → req.files (mapa por campo).
      const files = req.files as unknown;
      const uploaded: Express.MulterS3.File[] = req.file
        ? [req.file]
        : Array.isArray(files)
          ? (files as Express.MulterS3.File[])
          : (Object.values((files ?? {}) as Record<string, Express.MulterS3.File[]>).flat() as Express.MulterS3.File[]);

      let patched = { ...data };
      const replaced = new Set<string>();
      for (const file of uploaded) {
        const column = map[file.fieldname];
        if (!file.location || !column) continue;
        const previous = existing?.[column] as string | undefined;
        if (previous && op !== 'create') await uploadService.deleteImageFromS3(previous);
        patched[column] = file.location;
        replaced.add(column);
      }
      for (const column of Object.values(map)) {
        const previous = existing?.[column] as string | undefined;
        if (patched[column] === null && previous && !replaced.has(column)) {
          await uploadService.deleteImageFromS3(previous);
        }
        // campo de arquivo do multipart não é coluna
      }
      for (const field of Object.keys(map)) delete patched[field];
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
