/**
 * Objetos condicionais: mostrar só quando uma variável tiver valor.
 *
 * No editor, qualquer objeto (rótulo, linha, ícone…) pode levar
 * `showIf: 'inscricao_empresa'` — ou várias chaves separadas por vírgula, e aí
 * todas precisam estar preenchidas. Na hora de gerar, se alguma estiver vazia o
 * objeto sai. Serve para esconder "EMPRESA:" quando a inscrição não tem empresa,
 * "REGISTRO:" sem registro etc., sem criar um modelo para cada caso.
 *
 * Objeto sem `showIf` não muda nada.
 */
import type { CertificateVariables } from './variable-replacer';

export function showIfKeys(obj: any): string[] {
  const raw = obj?.showIf;
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((k) => k.trim().replace(/^\{\{|\}\}$/g, ''))
    .filter(Boolean);
}

function hasValue(variables: CertificateVariables, key: string) {
  const v = variables[key];
  return v != null && v.value != null && String(v.value).trim() !== '';
}

export function applyConditionalVisibility(
  json: any,
  variables: CertificateVariables,
): any {
  const objects: any[] = Array.isArray(json?.objects) ? json.objects : [];
  if (!objects.some((o) => showIfKeys(o).length)) return json;
  return {
    ...json,
    objects: objects.filter((o) =>
      showIfKeys(o).every((k) => hasValue(variables, k)),
    ),
  };
}
