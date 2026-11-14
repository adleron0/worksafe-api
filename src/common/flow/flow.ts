import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Esteira: a regra de passagem entre etapas, comum a tudo que anda por quadros
 * (ordem de serviço hoje; pedidos de compra e contas a pagar depois).
 *
 * Cada tipo de registro declara o mapa "de qual etapa para quais etapas" e o
 * rótulo de cada uma; aqui ficam a conferência e o histórico, para ninguém
 * reescrever isso por tela.
 */
export interface FlowDefinition<S extends string> {
  entity: string;
  labels: Record<S, string>;
  /** de → para (as passagens que existem) */
  moves: Record<S, S[]>;
}

export function assertMove<S extends string>(flow: FlowDefinition<S>, from: S, to: S): void {
  if (from === to) throw new ConflictException(`Já está em "${flow.labels[from]}"`);
  if (!(flow.moves[from] ?? []).includes(to)) {
    const options = (flow.moves[from] ?? []).map((stage) => `"${flow.labels[stage]}"`).join(' ou ');
    throw new ConflictException(`De "${flow.labels[from]}" não dá para ir direto para "${flow.labels[to]}"${options ? `: o próximo passo é ${options}` : ''}`);
  }
}

type Tx = Prisma.TransactionClient;
export interface FlowEventInput { companyId: number; entityId: number; type: string; from?: string | null; to?: string | null; userId?: number | null; note?: string | null }

export const recordFlowEvent = (tx: Tx, entity: string, event: FlowEventInput) =>
  tx.flow_Event.create({ data: {
    companyId: event.companyId, entity, entityId: event.entityId, type: event.type, fromStage: event.from ?? null, toStage: event.to ?? null,
    userId: event.userId || null, note: event.note ? event.note.slice(0, 1000) : null,
  } });

export const listFlowEvents = (tx: Tx, entity: string, entityId: number) =>
  tx.flow_Event.findMany({ where: { entity, entityId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
