import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ALL_PROPOSALS_PERMISSION, proposalsVisibleTo } from 'src/features/commercial/ownership';
import { ALL_ORDERS_PERMISSION, ordersVisibleTo } from 'src/features/operations/service-order.service';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Arquivo ligado a um registro (cliente, proposta, ordem de serviço): não fica em
 * pasta. Quem vê o registro vê os arquivos dele; quem pode alterar o registro
 * pode enviar e apagar. Vale o "só as minhas" de propostas e de OS.
 */
export const RECORD_ENTITIES = ['customer', 'proposal', 'service_order'] as const;
export type RecordEntity = (typeof RECORD_ENTITIES)[number];
export interface RecordActor { userId: number; companyId: number; permissions: string[] }
export interface RecordAccess { entity: RecordEntity; id: number; label: string; customerId: number | null; write: boolean }

const RULES: Record<RecordEntity, { view: string; write: string }> = {
  customer: { view: 'list_clientes', write: 'update_clientes' },
  proposal: { view: 'list_comercial', write: 'update_comercial' },
  service_order: { view: 'list_ordens_de_servico', write: 'update_ordens_de_servico' },
};

export function recordEntityOf(value: unknown): RecordEntity {
  if (!RECORD_ENTITIES.includes(value as RecordEntity)) throw new BadRequestException('Tipo de registro inválido');
  return value as RecordEntity;
}

/** As propostas e as OS que a pessoa enxerga (o "só as minhas"), como filtro. Nulo = não vê nenhuma daquele tipo. */
export async function visibleRecords(prisma: PrismaService, actor: RecordActor) {
  const can = (permission: string) => actor.permissions.includes(permission);
  return {
    customer: can(RULES.customer.view) ? {} : null,
    proposal: can(RULES.proposal.view) ? proposalsVisibleTo({ userId: actor.userId, companyId: actor.companyId, seesAll: can(ALL_PROPOSALS_PERMISSION) }) : null,
    service_order: can(RULES.service_order.view) ? await ordersVisibleTo(prisma, { userId: actor.userId, companyId: actor.companyId, seesAll: can(ALL_ORDERS_PERMISSION) }) : null,
  };
}

/** O registro, se existe e a pessoa o enxerga; sem acesso responde como se não existisse. */
export async function recordAccess(prisma: PrismaService, actor: RecordActor, entity: RecordEntity, id: number): Promise<RecordAccess> {
  const missing = () => new NotFoundException('Registro não encontrado');
  const can = (permission: string) => actor.permissions.includes(permission);
  if (!Number.isInteger(id) || id <= 0 || !can(RULES[entity].view)) throw missing();
  const write = can(RULES[entity].write);
  if (entity === 'customer') {
    const row = await prisma.customer.findFirst({ where: { id, companyId: actor.companyId }, select: { id: true, name: true } });
    if (!row) throw missing();
    return { entity, id, label: row.name, customerId: row.id, write };
  }
  if (entity === 'proposal') {
    const where = proposalsVisibleTo({ userId: actor.userId, companyId: actor.companyId, seesAll: can(ALL_PROPOSALS_PERMISSION) });
    const row = await prisma.commercial_Proposal.findFirst({ where: { AND: [{ id, companyId: actor.companyId }, where] }, select: { id: true, number: true, title: true, customerId: true } });
    if (!row) throw missing();
    return { entity, id, label: `${row.number} · ${row.title}`, customerId: row.customerId, write };
  }
  const where = await ordersVisibleTo(prisma, { userId: actor.userId, companyId: actor.companyId, seesAll: can(ALL_ORDERS_PERMISSION) });
  const row = await prisma.service_Order.findFirst({ where: { AND: [{ id, companyId: actor.companyId }, where] }, select: { id: true, number: true, title: true, customerId: true } });
  if (!row) throw missing();
  return { entity, id, label: `${row.number} · ${row.title}`, customerId: row.customerId, write };
}
