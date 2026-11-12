/**
 * Porte de `visualizadorCertificados/utils/VariableReplacer.ts` (front):
 * - troca `{{chave}}` nos textos;
 * - placeholder de imagem (Group `name: 'placeholder'`) → objeto Image com a
 *   URL da variável, centrado no placeholder (`targetWidth/Height` para o
 *   ajuste de escala depois que a imagem é baixada);
 * - placeholder de QR Code → marcador `isQRCodePlaceholder`.
 * Manter em sincronia com o front.
 */
import { isTextType } from './fabric-setup';

export type CertificateVariables = Record<
  string,
  { type?: string; value?: unknown } | undefined
>;

export function replaceInCanvasJSON(
  json: any,
  variables: CertificateVariables,
): any {
  if (!json) return json;
  const data =
    typeof json === 'string' ? JSON.parse(json) : structuredClone(json);
  if (Array.isArray(data.objects)) {
    data.objects = data.objects.map((o: any) => processObject(o, variables));
  }
  return data;
}

function replaceVariables(text: string, variables: CertificateVariables) {
  return text.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    const v = variables[key.trim()];
    // Diferente do visualizador antigo (que mantinha `{{chave}}`): no
    // certificado final, variável sem valor sai em branco.
    return v && v.value !== undefined && v.value !== null
      ? String(v.value)
      : '';
  });
}

function isPlaceholder(obj: any) {
  return (
    (obj.isPlaceholder && obj.placeholderName) ||
    (String(obj.type).toLowerCase() === 'group' && obj.name === 'placeholder')
  );
}

function placeholderNameOf(obj: any): string | undefined {
  if (obj.placeholderName) return obj.placeholderName;
  for (const id of [obj.id, obj.__uniqueID]) {
    if (typeof id === 'string') {
      const parts = id.split('_');
      if (parts[0] === 'placeholder' && parts.length >= 2) return parts[1];
    }
  }
  const textObj = Array.isArray(obj.objects)
    ? obj.objects.find((o: any) => isTextType(o.type) && o.text)
    : null;
  if (textObj) {
    const m = String(textObj.text).match(/📷\s*(.+)/);
    return (m ? m[1] : String(textObj.text).replace('📷', '')).trim();
  }
  return undefined;
}

function processObject(obj: any, variables: CertificateVariables): any {
  const out = { ...obj };

  if (isTextType(obj.type) && typeof obj.text === 'string') {
    out.text = replaceVariables(obj.text, variables);
  }

  if (isPlaceholder(obj)) {
    const name = placeholderNameOf(obj);
    const normalized = name?.toLowerCase().replace(/\s+/g, '');
    const isQR =
      obj.placeholderType === 'qrcode' ||
      normalized?.includes('qrcode') ||
      name?.toLowerCase().includes('qr code');
    if (isQR) {
      return {
        ...obj,
        isQRCodePlaceholder: true,
        qrCodeName: name || 'certificado_qrcode',
      };
    }

    const variable = name ? variables[name] : undefined;
    if (variable && variable.type === 'url' && variable.value) {
      const w = (obj.width || 200) * (obj.scaleX || 1);
      const h = (obj.height || 100) * (obj.scaleY || 1);
      return {
        type: 'Image',
        version: '6.7.1',
        originX: 'center',
        originY: 'center',
        left: obj.left + w / 2,
        top: obj.top + h / 2,
        scaleX: 1,
        scaleY: 1,
        angle: obj.angle || 0,
        opacity: obj.opacity ?? 1,
        src: String(variable.value),
        targetWidth: w,
        targetHeight: h,
        name: `image_${name}`,
      };
    }
    // Sem variável: o front mantém o placeholder; não desenhamos o tracejado
    // de edição no certificado final.
    return { ...obj, visible: false };
  }

  if (Array.isArray(obj.objects)) {
    out.objects = obj.objects.map((c: any) => processObject(c, variables));
  }
  return out;
}

/** `variableToReplace` chega como objeto, string JSON ou JSON em base64. */
export function parseCertificateVariables(raw: unknown): CertificateVariables {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as CertificateVariables;
  if (typeof raw !== 'string') return {};
  for (const decode of [
    (s: string) => s,
    (s: string) => Buffer.from(s, 'base64').toString('utf-8'),
  ]) {
    try {
      const parsed = JSON.parse(decode(raw));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* tenta o próximo formato */
    }
  }
  return {};
}
