/** Vencimento de documentos: a mesma regra para os de funcionário (RH) e os da empresa (Arquivos). Sem banco: testável sozinho. */

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

/** O pior primeiro: é o que aparece na pasta e na linha de quem tem os documentos. */
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
