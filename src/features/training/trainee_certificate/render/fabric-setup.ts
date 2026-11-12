/**
 * Setup do Fabric no Node para render de certificados — espelho de
 * `worksafe-front/.../visualizadorCertificados/utils/fabricSetup.ts`:
 * - registra as fontes de `geradorCertificados/utils/fontConfig.ts`
 *   (11 Google Fonts 400/700 + Arimo, de métricas iguais às da Arial, como `Arial`);
 * - registra a classe `ListTextbox` (todo texto criado no editor novo);
 * - aplica o patch de bold do editor (desenho letra por letra).
 *
 * Importe antes de qualquer `loadFromJSON`. As fontes precisam estar
 * registradas antes de o primeiro canvas ser criado.
 */
import { registerFont } from 'canvas';
import { existsSync } from 'fs';
import { join } from 'path';
import * as fabric from 'fabric/node';

const FONTS_DIR = join(process.cwd(), 'assets', 'fonts');

/** Família (como gravada no JSON) → prefixo do arquivo em assets/fonts. */
export const CERTIFICATE_FONTS: Record<string, string> = {
  'Bebas Neue': 'bebas-neue',
  Roboto: 'roboto',
  'Open Sans': 'open-sans',
  Lato: 'lato',
  Montserrat: 'montserrat',
  Poppins: 'poppins',
  Raleway: 'raleway',
  Inter: 'inter',
  'Playfair Display': 'playfair-display',
  Oswald: 'oswald',
  Merriweather: 'merriweather',
  Arial: 'arimo',
};

let ready = false;

export function setupFabric() {
  if (ready) return fabric;
  ready = true;

  for (const [family, file] of Object.entries(CERTIFICATE_FONTS)) {
    for (const weight of ['400', '700']) {
      const path = join(FONTS_DIR, `${file}-${weight}.ttf`);
      if (!existsSync(path)) continue; // Bebas Neue só tem 400
      registerFont(path, {
        family,
        weight: weight === '700' ? 'bold' : 'normal',
      });
    }
  }

  patchBoldRendering();
  fabric.classRegistry.setClass(ListTextbox, 'ListTextbox');
  return fabric;
}

/** Mesmo patch de `patchFabricBoldRendering` (fontConfig.ts do front). */
function patchBoldRendering() {
  const proto = fabric.FabricText.prototype as any;
  const original = proto._renderChars;
  if (!original) return;
  proto._renderChars = function (...args: unknown[]) {
    const isBold =
      this.fontWeight === 'bold' ||
      this.fontWeight === 700 ||
      this.fontWeight === '700';
    if (isBold && this.charSpacing === 0) {
      this.charSpacing = 1e-10;
      original.apply(this, args);
      this.charSpacing = 0;
    } else {
      original.apply(this, args);
    }
  };
}

/**
 * Só o necessário para desserializar e desenhar a `ListTextbox` do editor:
 * o texto salvo já vem com os marcadores, e o `lineHeight` salvo já inclui o
 * espaçamento da lista (ver `ListTextbox.fromObject` no front).
 */
export class ListTextbox extends fabric.Textbox {
  static type = 'ListTextbox';

  declare listType: string;
  declare listIndent: number;
  declare listItemSpacing: number;
  // Sem construtor próprio: o do front soma o espaçamento da lista ao
  // lineHeight, o que no load duplicaria o espaçamento já salvo.
}

export const TEXT_TYPES = new Set([
  'text',
  'i-text',
  'itext',
  'textbox',
  'listtextbox',
]);
export const TEXTBOX_TYPES = new Set(['textbox', 'listtextbox']);
export const isTextType = (type?: string) =>
  !!type && TEXT_TYPES.has(type.toLowerCase());
export const isTextboxType = (type?: string) =>
  !!type && TEXTBOX_TYPES.has(type.toLowerCase());

/** A4 a 72 dpi conforme a orientação (mesma regra do visualizador). */
export function getLogicalCanvasSize(rawWidth?: number, rawHeight?: number) {
  const w = rawWidth || 842;
  const h = rawHeight || 595;
  return w > h ? { width: 842, height: 595 } : { width: 595, height: 842 };
}
