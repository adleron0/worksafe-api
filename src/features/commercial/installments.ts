import { round2 } from './pricing/engine';

/**
 * Valor de cada parcela, em centavos fechados. Percentual é sobre o total já
 * arredondado; quando as parcelas são todas percentuais e somam 100%, a última
 * absorve o centavo que sobrar, para a soma bater com o total.
 */
export function installmentValues(total: number, installments: Array<{ percent: number | null; amount: number | null }>): number[] {
  const rounded = round2(total);
  const values = installments.map((inst) => round2(inst.percent !== null ? rounded * inst.percent : inst.amount ?? 0));
  const allPercent = installments.length > 0 && installments.every((inst) => inst.percent !== null);
  const percentSum = installments.reduce((sum, inst) => sum + (inst.percent ?? 0), 0);
  if (allPercent && Math.abs(percentSum - 1) < 1e-6) {
    const others = values.slice(0, -1).reduce((sum, value) => sum + value, 0);
    values[values.length - 1] = round2(rounded - others);
  }
  return values;
}
