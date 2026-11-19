import { BadRequestException } from '@nestjs/common';

/**
 * Plano de medição de obra (plano 08, fase 8): como uma venda de serviço é
 * faturada quando o modo é `medicao` em vez de parcelas.
 *
 * - **Frentes**: a obra quebrada em frentes (em geral as etapas do cronograma),
 *   cada uma com um peso (% do valor medido). Regra `percentual` = mede o %
 *   concluído no período; `conclusao` = só entra no boletim quando chega a 100%.
 * - **Mobilização**: `etapa` (padrão) = uma etapa própria de X% faturada no
 *   início, e as frentes dividem o resto; `adiantamento` = X% faturados no
 *   início e abatidos proporcionalmente de cada boletim até zerar; `nenhuma`.
 * - **Caução contratual**: % retido de cada boletim até o fim da obra, numa
 *   conta a receber própria (liberada `depositReleaseDays` após a conclusão).
 */

export type FrontRule = 'percentual' | 'conclusao';
export type MobilizationMode = 'nenhuma' | 'etapa' | 'adiantamento';
export interface PlanFront { step: number | null; title: string; weight: number; rule: FrontRule }
export interface MeasurementPlanInput {
  mode: 'parcelas' | 'medicao';
  fronts: PlanFront[];
  mobilization: { mode: MobilizationMode; rate: number };
  depositRate: number;
  depositReleaseDays: number;
}
export interface ContractFront extends PlanFront { id: number; value: number }
export interface ContractPlan {
  fronts: ContractFront[];
  mobilization: { mode: MobilizationMode; rate: number; value: number };
  depositRate: number; depositReleaseDays: number; total: number;
}

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const blank = (value: unknown) => value === undefined || value === null || value === '';
const clean = (value: unknown, max = 160) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
function fraction(value: unknown, label: string, max: number, fallback: number): number {
  if (blank(value)) return fallback;
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > max) throw new BadRequestException(`${label}: valor inválido`);
  return round6(n);
}

interface ScheduleLike { steps?: Array<{ title?: string; duration?: number }> }

/** Frentes iniciais: as etapas do cronograma, com peso pela duração; sem cronograma, uma frente só. */
export function frontsFromSchedule(schedule: unknown): PlanFront[] {
  const steps = ((schedule as ScheduleLike | null)?.steps ?? []).filter((s) => clean(s?.title));
  if (!steps.length) return [{ step: null, title: 'Execução do serviço', weight: 1, rule: 'percentual' }];
  const durations = steps.map((s) => Math.max(1, Number(s.duration) || 1));
  const sum = durations.reduce((a, b) => a + b, 0);
  const weights = durations.map((d) => round6(d / sum));
  weights[weights.length - 1] = round6(1 - weights.slice(0, -1).reduce((a, b) => a + b, 0));
  return steps.map((s, index) => ({ step: index, title: clean(s.title), weight: weights[index], rule: 'percentual' }));
}

/**
 * Lê o plano mandado pela tela. `null` = parcelas (o jeito de sempre). Não
 * exige que os pesos fechem 100% (rascunho): isso é conferido no envio.
 */
export function parsePlan(raw: unknown, schedule: unknown): MeasurementPlanInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, any>;
  if (body.mode !== 'medicao') return null;
  const list = Array.isArray(body.fronts) ? body.fronts : [];
  if (list.length > 60) throw new BadRequestException('Frentes demais (máximo 60)');
  const fronts: PlanFront[] = list.length
    ? list.map((f: Record<string, unknown>, index: number) => {
      const title = clean(f?.title);
      if (!title) throw new BadRequestException(`Frente ${index + 1}: informe o nome`);
      const step = blank(f.step) ? null : Number(f.step);
      return {
        step: step !== null && Number.isInteger(step) && step >= 0 ? step : null, title,
        weight: fraction(f.weight, `Peso da frente "${title}"`, 1, 0), rule: f.rule === 'conclusao' ? 'conclusao' : 'percentual',
      };
    })
    : frontsFromSchedule(schedule);
  const mob = (body.mobilization ?? {}) as Record<string, unknown>;
  const mode: MobilizationMode = mob.mode === 'nenhuma' || mob.mode === 'adiantamento' ? mob.mode : 'etapa';
  return {
    mode: 'medicao', fronts,
    mobilization: { mode, rate: mode === 'nenhuma' ? 0 : fraction(mob.rate, 'Mobilização', 0.9, 0.3) },
    depositRate: fraction(body.depositRate, 'Caução', 0.3, 0),
    depositReleaseDays: Math.round(fraction(body.depositReleaseDays, 'Prazo de liberação da caução', 3650, 0)),
  };
}

/** O que impede enviar a proposta com este plano (ou null). */
export function planProblem(plan: MeasurementPlanInput): string | null {
  if (!plan.fronts.length) return 'A medição precisa de pelo menos uma frente';
  const sum = plan.fronts.reduce((s, f) => s + f.weight, 0);
  if (Math.abs(sum - 1) > 0.0005) return `Os pesos das frentes somam ${(sum * 100).toFixed(2).replace('.', ',')}%: precisam fechar 100%`;
  if (plan.mobilization.mode !== 'nenhuma' && plan.mobilization.rate <= 0) return 'Informe o percentual da mobilização (ou escolha "sem mobilização")';
  return null;
}

/** Plano do contrato: o valor em reais de cada frente, da mobilização e as regras. */
export function contractPlanOf(plan: MeasurementPlanInput, total: number): ContractPlan {
  const mobValue = plan.mobilization.mode === 'nenhuma' ? 0 : round2(total * plan.mobilization.rate);
  // na etapa própria as frentes dividem o que sobra; no adiantamento medem o contrato inteiro
  const measurable = plan.mobilization.mode === 'etapa' ? round2(total - mobValue) : total;
  const sum = plan.fronts.reduce((s, f) => s + f.weight, 0) || 1;
  const values = plan.fronts.map((f) => round2((measurable * f.weight) / sum));
  if (values.length) values[values.length - 1] = round2(measurable - values.slice(0, -1).reduce((a, b) => a + b, 0));
  return {
    fronts: plan.fronts.map((f, index) => ({ ...f, id: index + 1, value: values[index] })),
    mobilization: { ...plan.mobilization, value: mobValue },
    depositRate: plan.depositRate, depositReleaseDays: plan.depositReleaseDays, total,
  };
}

const pct = (value: number) => `${(Math.round(value * 10000) / 100).toString().replace('.', ',')}%`;
const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Condições de faturamento por medição, em texto, para o documento da proposta. */
export function planTerms(plan: MeasurementPlanInput, total: number): string[] {
  const c = contractPlanOf(plan, total);
  const lines = ['Faturamento por medição: ao fim de cada período é emitido um boletim de medição (BM) com o executado em cada frente, para aprovação; cada BM aprovado gera uma nota fiscal no valor medido.'];
  if (c.mobilization.mode === 'etapa') lines.push(`Mobilização de ${pct(c.mobilization.rate)} (${money(c.mobilization.value)}) faturada no início, como etapa própria; os boletins seguintes medem os ${pct(1 - c.mobilization.rate)} restantes.`);
  if (c.mobilization.mode === 'adiantamento') lines.push(`Adiantamento de ${pct(c.mobilization.rate)} (${money(c.mobilization.value)}) faturado no início e abatido proporcionalmente de cada boletim até zerar.`);
  lines.push(`Frentes medidas: ${c.fronts.map((f) => `${f.title} (${money(f.value)}${f.rule === 'conclusao' ? ', medida ao concluir' : ''})`).join('; ')}.`);
  if (c.depositRate > 0) lines.push(`Caução contratual de ${pct(c.depositRate)} retida de cada boletim e paga ${c.depositReleaseDays ? `${c.depositReleaseDays} dias após` : 'na'} conclusão da obra.`);
  return lines;
}
