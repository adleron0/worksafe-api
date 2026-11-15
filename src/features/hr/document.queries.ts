import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { documentStatus, requiredFor } from './document.rules';

/**
 * Pendências de documento de um grupo de funcionários, para quem monta equipe
 * ou reúne os documentos de uma obra: vencido, obrigatório faltando, a vencer
 * e o que vence antes do fim da obra (`until`).
 */
export type DocumentIssueKind = 'vencido' | 'faltando' | 'vence_antes' | 'a_vencer';
export interface DocumentIssue { typeId: number; typeName: string; kind: DocumentIssueKind; expiryDate: string | null }

const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);

export async function documentIssues(
  prisma: PrismaService | Prisma.TransactionClient, companyId: number, employeeIds: number[], today: string, until: string | null = null,
): Promise<Map<number, DocumentIssue[]>> {
  const out = new Map<number, DocumentIssue[]>();
  if (!employeeIds.length) return out;
  const [documents, types, employees] = await Promise.all([
    prisma.hr_EmployeeDocument.findMany({ where: { companyId, employeeId: { in: employeeIds }, inactiveAt: null, replacedAt: null }, include: { type: true } }),
    prisma.hr_DocumentType.findMany({ where: { companyId, inactiveAt: null, required: true } }),
    prisma.hr_Employee.findMany({ where: { id: { in: employeeIds }, companyId }, select: { id: true, roles: { select: { professionalId: true } } } }),
  ]);
  const push = (employeeId: number, issue: DocumentIssue) => out.set(employeeId, [...(out.get(employeeId) ?? []), issue]);
  const have = new Map<number, Set<number>>();
  for (const document of documents) {
    have.set(document.employeeId, (have.get(document.employeeId) ?? new Set()).add(document.typeId));
    const expiry = iso(document.expiryDate);
    if (!expiry) continue;
    const status = documentStatus(expiry, document.type.warnDays, today);
    const base = { typeId: document.typeId, typeName: document.type.name, expiryDate: expiry };
    if (status === 'vencido') push(document.employeeId, { ...base, kind: 'vencido' });
    else if (until && expiry < until) push(document.employeeId, { ...base, kind: 'vence_antes' });
    else if (status === 'a_vencer') push(document.employeeId, { ...base, kind: 'a_vencer' });
  }
  for (const employee of employees) {
    const roleIds = employee.roles.map((role) => role.professionalId);
    for (const type of types) if (!have.get(employee.id)?.has(type.id) && requiredFor(type, roleIds)) push(employee.id, { typeId: type.id, typeName: type.name, kind: 'faltando', expiryDate: null });
  }
  return out;
}
