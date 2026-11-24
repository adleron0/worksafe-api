import { UseInterceptors } from '@nestjs/common';
import { NoFilesInterceptor } from '@nestjs/platform-express';

/**
 * Formulário público (prova, avaliação, inscrição, validação do aluno): o
 * front e o site enviam multipart/form-data, e sem um interceptor do multer o
 * Nest nem parseia o corpo — chega vazio. Antes era um FileInterceptor com
 * multer-s3: qualquer um, sem login, subia até 20 MB (SVG inclusive) no bucket
 * público, e nenhuma dessas rotas usa arquivo. Aqui só campos: arquivo = 400.
 */
export const PUBLIC_FORM_LIMITS = {
  files: 0,
  fields: 100,
  fieldSize: 1024 * 1024, // 1 MB por campo (examResponses é o maior)
};

export function PublicFormFields(): MethodDecorator {
  return UseInterceptors(NoFilesInterceptor({ limits: PUBLIC_FORM_LIMITS }));
}
