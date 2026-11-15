/** Documentos do funcionário: pastas, situação pelo vencimento e a lista inicial de tipos. Sem banco: testável sozinho. */

export const DOCUMENT_FOLDERS = [
  { id: 'admissao', name: 'Admissão e contrato' },
  { id: 'saude', name: 'Saúde (ASO)' },
  { id: 'treinamentos', name: 'Treinamentos e NRs' },
  { id: 'pessoais', name: 'Documentos pessoais' },
  { id: 'outros', name: 'Outros' },
];

// A regra de vencimento é comum ao RH e aos Arquivos da empresa.
export { DOCUMENT_STATUS_LABEL, documentStatus, suggestedExpiry, worstStatus } from 'src/common/documents/expiry';
export type { DocumentStatus, FolderStatus } from 'src/common/documents/expiry';

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
