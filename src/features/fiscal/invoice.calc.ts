import { pisCofinsOf } from './dps.builder';
import { round2, toNumber } from './fiscal.utils';

/**
 * Contas da nota: base, ISS, retenções e líquido. Função pura, usada na prévia
 * da tela, na gravação do rascunho e na montagem da DPS (os mesmos números nos
 * três lugares).
 */

export const FEDERAL_TAXES = ['inss', 'ir', 'csll', 'pis', 'cofins'] as const;
export type FederalTax = (typeof FEDERAL_TAXES)[number];
export const FEDERAL_LABEL: Record<FederalTax, string> = { inss: 'INSS', ir: 'IR', csll: 'CSLL', pis: 'PIS', cofins: 'COFINS' };

/** Retenção informada: alíquota em % sobre a base e/ou valor (valor vale mais, exceto PIS/COFINS, que vão por alíquota). */
export type RetentionField = { rate?: number | null; value?: number | null };

export interface CalcInput {
  gross: number;
  discount?: number;
  issRate?: number | null;
  issWithheld?: boolean;
  retentions?: Partial<Record<FederalTax, RetentionField>>;
}

export interface CalcLine { tax: FederalTax | 'iss'; rate: number | null; value: number }

export interface CalcResult {
  gross: number;
  discount: number;
  base: number;
  issRate: number | null;
  issValue: number;
  issWithheld: boolean;
  federal: Record<FederalTax, CalcLine>;
  federalTotal: number;
  retainedTotal: number; // o que o cliente desconta do pagamento
  net: number;
  lines: CalcLine[]; // retenções com valor (para o financeiro)
  errors: string[];
}

export function calcInvoice(input: CalcInput): CalcResult {
  const errors: string[] = [];
  const gross = round2(toNumber(input.gross));
  const discount = round2(toNumber(input.discount));
  const base = round2(gross - discount);
  if (gross <= 0) errors.push('Informe o valor do serviço.');
  if (discount < 0 || (discount > 0 && discount >= gross)) errors.push('O desconto precisa ser menor que o valor do serviço.');

  const issRate = input.issRate === null || input.issRate === undefined || (input.issRate as unknown) === '' ? null : round2(toNumber(input.issRate));
  if (issRate !== null && (issRate < 0 || issRate > 5)) errors.push('A alíquota do ISS vai de 0 a 5%.');
  const issValue = issRate ? round2((base * issRate) / 100) : 0;
  const issWithheld = !!input.issWithheld;
  if (issWithheld && !issRate) errors.push('Com ISS retido pelo cliente, informe a alíquota do ISS.');

  const r = input.retentions ?? {};
  const pc = pisCofinsOf(base, { pisRate: toNumber(r.pis?.rate), cofinsRate: toNumber(r.cofins?.rate) });
  const lineOf = (tax: FederalTax): CalcLine => {
    const field = r[tax] ?? {};
    const rate = field.rate === null || field.rate === undefined || (field.rate as unknown) === '' ? null : round2(toNumber(field.rate));
    if (tax === 'pis') return { tax, rate, value: pc?.pis ?? 0 };
    if (tax === 'cofins') return { tax, rate, value: pc?.cofins ?? 0 };
    const typed = field.value === null || field.value === undefined || (field.value as unknown) === '' ? null : round2(toNumber(field.value));
    const value = typed !== null ? typed : rate ? round2((base * rate) / 100) : 0;
    return { tax, rate: typed !== null && rate === null ? (base ? round2((typed / base) * 100) : null) : rate, value };
  };
  const federal = Object.fromEntries(FEDERAL_TAXES.map((t) => [t, lineOf(t)])) as Record<FederalTax, CalcLine>;
  for (const t of FEDERAL_TAXES) if (federal[t].value < 0) errors.push(`A retenção de ${FEDERAL_LABEL[t]} não pode ser negativa.`);
  const federalTotal = round2(FEDERAL_TAXES.reduce((s, t) => s + federal[t].value, 0));
  const retainedTotal = round2(federalTotal + (issWithheld ? issValue : 0));
  // E0428: o valor do serviço cobre descontos e retenções
  if (gross > 0 && discount + retainedTotal >= gross) errors.push('Descontos e retenções somados chegam ao valor do serviço.');
  const net = round2(base - retainedTotal);
  const lines: CalcLine[] = [
    ...(issWithheld && issValue > 0 ? [{ tax: 'iss' as const, rate: issRate, value: issValue }] : []),
    ...FEDERAL_TAXES.map((t) => federal[t]).filter((l) => l.value > 0),
  ];
  return { gross, discount, base, issRate, issValue, issWithheld, federal, federalTotal, retainedTotal, net, lines, errors };
}

/** Troca as variáveis {chave} do modelo de discriminação. Variável sem valor some. */
export function fillTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return String(template ?? '')
    .replace(/\{(\w+)\}/g, (_, key: string) => {
      const value = vars[key];
      return value === null || value === undefined ? '' : String(value);
    })
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export const brl = (value: number) => round2(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
