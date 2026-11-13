import { CostBaseParams, CostItem, TaxBracket } from './engine';

/**
 * Valores da planilha FORM-COM-001 (abas CALC e MDO), lidos em 13/11/2026.
 * É a carga inicial da base de cálculo e a referência do teste de ouro.
 *
 * Aviso prévio e rescisão aparecem como 8,33% + 8,33% na planilha, mas o
 * grupo soma 16,67% e B fecha em 46,16% — por isso 8,335% em cada.
 */
export const SHEET_PARAMS: CostBaseParams = {
  daysInYear: 365, restDays: 88, vacationDays: 30, holidays: 15,
  hoursPerDay: 8, idleRate: 0.1, monthsDivisor: 11,
  additionalDivisor: 220, nightRate: 0.2, travelRate: 0.25, weekendRate: 2, weekendPerWorker: false,
  mealPerDay: 30, transportFare: 4.5, transportTrips: 6, transportDiscount: 0.6,
  fareDiscountRate: 0.06,
  headcount: 17,
};

type SeedItem = CostItem & { subgroup: string; name: string };
const charge = (subgroup: string, name: string, rate: number): SeedItem => ({ group: 'encargo', subgroup, name, rate });
const staff = (name: string, amount: number, quantity = 1, withCharges = true): SeedItem =>
  ({ group: 'pessoal_indireto', subgroup: withCharges ? 'Cargos indiretos' : 'Pró-labore', name, amount, quantity, withCharges });
const other = (subgroup: string, name: string, amount: number, isDebt = false): SeedItem =>
  ({ group: 'outro_custo', subgroup, name, amount, quantity: 1, kind: 'fixo', isDebt });

export const SHEET_ITEMS: SeedItem[] = [
  charge('Básicos', 'FGTS', 0.08),
  charge('Trabalhistas', 'Férias + abono 1/3', 0.1111),
  charge('Trabalhistas', '13º salário', 0.0833),
  charge('Indenizatórios', 'Aviso prévio', 0.08335),
  charge('Indenizatórios', 'Rescisão sem justa causa', 0.08335),
  charge('Cumulativas', 'Férias sobre aviso prévio', 0.0069),
  charge('Cumulativas', '13º sobre aviso prévio', 0.0069),
  charge('Cumulativas', 'FGTS sobre aviso prévio', 0.0067),

  staff('Pró-labore', 7500, 1, false),
  staff('Técnico de Segurança', 2500),
  staff('Supervisor ADM', 3725.02),
  staff('Engenheiro', 5974),
  staff('Auxiliar Comercial', 1735.41),
  staff('Financeiro/RH/DP', 1871.7),
  staff('Almoxarife', 1871.7),
  staff('Planejador', 2521.34, 0),

  other('Sistema e comunicação', 'OMIE', 600),
  other('Sistema e comunicação', 'Telefonia móvel', 1000),
  other('Sistema e comunicação', 'RDO', 160),
  other('Sistema e comunicação', 'Google Workspace', 560),
  other('Sistema e comunicação', 'Servidor Drive Google', 120),
  other('Sistema e comunicação', 'Ponto eletrônico (Tangerino)', 506.32),
  other('Estrutura e ADM', 'Aluguel do escritório', 2440),
  other('Estrutura e ADM', 'Energia', 950),
  other('Estrutura e ADM', 'Água', 0),
  other('Estrutura e ADM', 'Internet fixa', 169),
  other('Estrutura e ADM', 'Segurança C.T', 357.5),
  other('Jurídico, contábil e financeiro', 'Advogados', 1614),
  other('Jurídico, contábil e financeiro', 'Contabilidade', 2081),
  other('Jurídico, contábil e financeiro', 'Empréstimos', 15000, true),
  other('Jurídico, contábil e financeiro', 'Impostos em atraso', 10000, true),
  other('EPIs, fardamentos e outros', 'EPIs', 5500),
  other('EPIs, fardamentos e outros', 'Aluguel de carros', 0),
  other('EPIs, fardamentos e outros', 'Parcelas de carros', 1780),
  other('EPIs, fardamentos e outros', 'Combustível médio', 5000),
  other('EPIs, fardamentos e outros', 'Seguro de vida', 278),
];

export const SHEET_PROFESSIONALS: Array<{ name: string; salary: number }> = [
  { name: 'Bombeiro Civil I', salary: 1937.2 }, { name: 'Bombeiro Civil II', salary: 2036.85 },
  { name: 'Auxiliar de Manutenção', salary: 1761.6 }, { name: 'Assistente de Manutenção', salary: 1930.37 },
  { name: 'Coord. de Manutenção', salary: 2549.22 }, { name: 'Pintor', salary: 1899 },
  { name: 'Soldador I', salary: 1899 }, { name: 'Soldador II', salary: 5500 },
  { name: 'Alpinista N1', salary: 2426.5 }, { name: 'Alpinista N2', salary: 2937.5 },
  { name: 'Alpinista N3', salary: 4500 }, { name: 'Resgatista', salary: 1780.84 },
  { name: 'Técnico de Segurança', salary: 2500 }, { name: 'Pintor II', salary: 2937.5 },
  { name: 'Resgatista II', salary: 2426.5 }, { name: 'Engenheiro', salary: 5974 },
];

/** Simples Nacional, Anexo III. */
export const SHEET_BRACKETS: TaxBracket[] = [
  { limit: 180000, rate: 0.06, deduction: 0 },
  { limit: 360000, rate: 0.112, deduction: 9360 },
  { limit: 720000, rate: 0.135, deduction: 17640 },
  { limit: 1800000, rate: 0.16, deduction: 35640 },
  { limit: 3600000, rate: 0.21, deduction: 125640 },
  { limit: 4800000, rate: 0.33, deduction: 648000 },
];
export const SHEET_RBT12 = 3600000;

export const SHEET_DEFAULTS = {
  margins: { mao_de_obra: 0.26, locacao: 0.05, material: 0, treinamento: 0, avulso: 0 },
  contingencyLevels: [
    { label: 'Nula', rate: 0 }, { label: 'Baixa', rate: 0.05 }, { label: 'Normal', rate: 0.1 },
    { label: 'Média', rate: 0.15 }, { label: 'Alta', rate: 0.2 },
  ],
  contingencyRate: 0.05,
  commission: { rate: 0.02, base: 'faturado', inPrice: false },
};

/** Tabela MDO da planilha: [nome, custo hora, noturno, viagem, FDS/feriado]. */
export const SHEET_MDO: Array<[string, number, number, number, number]> = [
  ['Bombeiro Civil I', 54.53, 2.57, 3.22, 25.74], ['Bombeiro Civil II', 55.45, 2.71, 3.38, 27.06],
  ['Auxiliar de Manutenção', 52.91, 2.34, 2.93, 23.41], ['Assistente de Manutenção', 54.47, 2.56, 3.21, 25.65],
  ['Coord. de Manutenção', 60.18, 3.39, 4.23, 33.87], ['Pintor', 54.18, 2.52, 3.15, 25.23],
  ['Soldador I', 54.18, 2.52, 3.15, 25.23], ['Soldador II', 87.42, 7.31, 9.14, 73.08],
  ['Alpinista N1', 59.05, 3.22, 4.03, 32.24], ['Alpinista N2', 63.77, 3.9, 4.88, 39.03],
  ['Alpinista N3', 78.19, 5.98, 7.47, 59.79], ['Resgatista', 53.09, 2.37, 2.96, 23.66],
  ['Técnico de Segurança', 59.73, 3.32, 4.15, 33.22], ['Pintor II', 63.77, 3.9, 4.88, 39.03],
  ['Resgatista II', 59.05, 3.22, 4.03, 32.24], ['Engenheiro', 91.79, 7.94, 9.92, 79.38],
];
