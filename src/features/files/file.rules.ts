/** Arquivos da empresa: regras sem banco (nomes, o que abre no navegador, pastas iniciais). Testável sozinho. */

export const FILE_MAX_BYTES = 25 * 1024 * 1024;
/** Quanto tempo um arquivo ou pasta fica na lixeira antes de sumir de verdade. */
export const TRASH_DAYS = 30;

/** Pastas com que cada empresa começa; todas podem ser renomeadas ou apagadas. */
export const DEFAULT_FOLDERS = [
  'Societário e fiscal', 'Licenças e alvarás', 'Segurança do trabalho', 'Certidões', 'Contratos', 'Seguros', 'Modelos e padrões', 'Fotos e vídeos', 'Outros',
];

/** Nome de pasta ou de arquivo: sem barras nem caracteres de controle, espaços enxutos. */
export function cleanName(value: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').normalize('NFC').replace(/[\\/\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Para comparar e buscar: sem acento e sem diferença de maiúsculas. */
export const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * O envio em formulário entrega o nome do arquivo lido como latin1; "relatório.pdf"
 * chega "relatÃ³rio.pdf". Se o texto relido como UTF-8 for válido, é ele que vale.
 */
export function uploadedName(raw: string): string {
  if (!/[\u0080-ÿ]/.test(raw) || /[^\u0000-ÿ]/.test(raw)) return raw;
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  return decoded.includes('�') ? raw : decoded;
}

export const extensionOf = (name: string) => (name.match(/\.[a-zA-Z0-9]{1,8}$/)?.[0] ?? '').toLowerCase();

/** Só estes tipos abrem dentro do navegador; todo o resto (inclusive HTML e SVG) é sempre baixado. */
const INLINE = /^(application\/pdf|image\/(jpeg|png|webp|gif|avif|heic|heif)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm)|text\/plain)$/;
export const opensInline = (mimeType: string) => INLINE.test(mimeType);

/** O nome com que o arquivo é baixado: o nome mostrado, com a extensão original se a pessoa a tirou ao renomear. */
export function downloadName(name: string, fileName: string): string {
  const extension = extensionOf(fileName);
  return extension && extensionOf(name) !== extension ? `${name}${extension}` : name;
}
