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
 * Upload de imagem via multipart (`FileInterceptor('image', …)` no controller):
 * o arquivo já está no S3 quando o hook roda; grava a URL no campo e apaga a
 * imagem anterior ao substituir ou ao enviar `imageUrl: null`. É um concern
 * do projeto — o núcleo não sabe o que é S3.
 */
export function imageUpload(field = 'imageUrl'): EntityHooks<Request> {
  return {
    preWrite: async ({ context, op, data, existing }) => {
      const file = (context as Request & { file?: Express.MulterS3.File }).file;
      const previous = existing?.[field] as string | undefined;
      if (file?.location) {
        if (previous && op !== 'create') await uploadService.deleteImageFromS3(previous);
        return { ...data, [field]: file.location };
      }
      // Sem arquivo novo e com pedido explícito de remoção.
      if (data[field] === null && previous) {
        await uploadService.deleteImageFromS3(previous);
      }
      return undefined;
    },
  };
}
