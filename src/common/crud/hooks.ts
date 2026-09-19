import { EntityHooks } from '@adleron/crud-core';
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
