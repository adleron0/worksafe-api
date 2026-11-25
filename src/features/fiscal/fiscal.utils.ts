import { MUNICIPIOS_IBGE } from './data/municipios-ibge';

export const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');
export const round2 = (value: number) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
export const toNumber = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
export const clean = (value: unknown, max?: number) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max ? text.slice(0, max) : text;
};

/** Escapa texto para dentro de um elemento XML. */
export const xmlText = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // caracteres de controle não são aceitos no XML (exceto quebra de linha e tab)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Valor monetário no formato da NFS-e (TSDec15V2): "0", "10", "10.50". */
export const money = (value: number) => {
  const v = round2(value);
  if (v === 0) return '0';
  return v.toFixed(2);
};

/** Alíquota no formato TSDec1V2 ("5.00") ou TSDec2V2 ("11.00"). */
export const rate = (value: number) => round2(value).toFixed(2);

/** Normaliza nome de cidade para comparar: sem acento, minúsculo, sem pontuação. */
export const normalizeName = (value: unknown) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

let ibgeIndex: Map<string, string> | null = null;
/** Código IBGE de 7 dígitos pelo nome da cidade e a UF (tabela oficial do Portal NFS-e). */
export function ibgeOf(cityName: unknown, uf: unknown): string | null {
  if (!ibgeIndex) {
    ibgeIndex = new Map();
    for (const [u, nome, codigo] of MUNICIPIOS_IBGE) ibgeIndex.set(`${u}|${normalizeName(nome)}`, codigo);
  }
  const key = `${String(uf ?? '').toUpperCase()}|${normalizeName(cityName)}`;
  return ibgeIndex.get(key) ?? null;
}

/** Nome da cidade pelo código IBGE (para mostrar na tela e no PDF). */
export function cityOfIbge(code: string): { uf: string; name: string } | null {
  const found = MUNICIPIOS_IBGE.find((row) => row[2] === code);
  return found ? { uf: found[0], name: found[1] } : null;
}

/** Data AAAA-MM-DD no fuso de Brasília. */
export const todayBr = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

/** Data e hora no formato TSDateTimeUTC com fuso de Brasília: 2026-11-25T14:03:00-03:00. */
export function dateTimeBr(date = new Date()): string {
  const local = new Date(date.getTime() - 3 * 3600 * 1000);
  return `${local.toISOString().slice(0, 19)}-03:00`;
}

export const isCpf = (doc: string) => digits(doc).length === 11;
export const isCnpj = (doc: string) => digits(doc).length === 14;
