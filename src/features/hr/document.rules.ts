/** Documentos do funcionário: pastas, situação pelo vencimento e a lista inicial de tipos. Sem banco: testável sozinho. */

export const DOCUMENT_FOLDERS = [
  { id: 'admissao', name: 'Admissão e contrato' },
  { id: 'saude', name: 'Saúde (ASO)' },
  { id: 'treinamentos', name: 'Treinamentos e NRs' },
  { id: 'pessoais', name: 'Documentos pessoais' },
  { id: 'outros', name: 'Outros' },
];

export type DocumentStatus = 'em_dia' | 'a_vencer' | 'vencido' | 'sem_validade';
export type FolderStatus = DocumentStatus | 'faltando' | 'vazia';
export const DOCUMENT_STATUS_LABEL: Record<FolderStatus, string> = {
  em_dia: 'Em dia', a_vencer: 'A vencer', vencido: 'Vencido', sem_validade: 'Sem validade', faltando: 'Faltando', vazia: 'Vazia',
};

const addDays = (day: string, days: number) => new Date(new Date(`${day}T00:00:00.000Z`).getTime() + days * 86400000).toISOString().slice(0, 10);

/** Situação de um documento hoje: vencido se a validade passou; a vencer dentro do aviso do tipo. */
export function documentStatus(expiryDate: string | null, warnDays: number, today: string): DocumentStatus {
  if (!expiryDate) return 'sem_validade';
  if (expiryDate < today) return 'vencido';
  return expiryDate <= addDays(today, Math.max(0, warnDays)) ? 'a_vencer' : 'em_dia';
}

/** O pior primeiro: é o que aparece na pasta e na linha do funcionário. */
const SEVERITY: FolderStatus[] = ['vencido', 'faltando', 'a_vencer', 'em_dia', 'sem_validade', 'vazia'];
export function worstStatus(statuses: FolderStatus[]): FolderStatus {
  return statuses.reduce<FolderStatus>((worst, status) => (SEVERITY.indexOf(status) < SEVERITY.indexOf(worst) ? status : worst), 'vazia');
}

/** Vencimento sugerido: emissão + validade do tipo, no mesmo dia do mês (31/01 + 1 mês = último dia de fevereiro). */
export function suggestedExpiry(issueDate: string, validityMonths: number): string {
  const [year, month, day] = issueDate.split('-').map(Number);
  const total = month - 1 + validityMonths;
  const targetYear = year + Math.floor(total / 12);
  const targetMonth = total % 12;
  const last = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, last))).toISOString().slice(0, 10);
}

/** Obrigatório para a pessoa: para todos, ou só para quem exerce uma das funções marcadas. */
export function requiredFor(type: { required: boolean; requiredProfessionalIds: unknown }, professionalIds: number[]): boolean {
  if (!type.required) return false;
  const only = Array.isArray(type.requiredProfessionalIds) ? type.requiredProfessionalIds.map(Number).filter((id) => id > 0) : [];
  return only.length === 0 || only.some((id) => professionalIds.includes(id));
}

/** Tipos com que cada empresa começa; o RH ajusta depois. */
export const DEFAULT_DOCUMENT_TYPES: Array<{ name: string; folder: string; expires?: boolean; validityMonths?: number; required?: boolean; inIntegration?: boolean }> = [
  { name: 'Ficha de registro', folder: 'admissao', inIntegration: true },
  { name: 'Contrato de trabalho', folder: 'admissao' },
  { name: 'Ficha de EPI', folder: 'admissao', inIntegration: true },
  { name: 'Ordem de serviço de segurança (NR-01)', folder: 'admissao', inIntegration: true },
  { name: 'ASO', folder: 'saude', expires: true, validityMonths: 12, required: true, inIntegration: true },
  { name: 'Comprovante de vacinação', folder: 'saude' },
  { name: 'NR-06 (EPI)', folder: 'treinamentos', inIntegration: true },
  { name: 'NR-10', folder: 'treinamentos', expires: true, validityMonths: 24, inIntegration: true },
  { name: 'NR-12', folder: 'treinamentos', inIntegration: true },
  { name: 'NR-18', folder: 'treinamentos', expires: true, validityMonths: 24, inIntegration: true },
  { name: 'NR-20', folder: 'treinamentos', expires: true, validityMonths: 12, inIntegration: true },
  { name: 'NR-33', folder: 'treinamentos', expires: true, validityMonths: 12, inIntegration: true },
  { name: 'NR-35', folder: 'treinamentos', expires: true, validityMonths: 24, inIntegration: true },
  { name: 'RG e CPF', folder: 'pessoais', inIntegration: true },
  { name: 'CNH', folder: 'pessoais', expires: true },
];
