import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * "Só as minhas" do Comercial. Fica num arquivo sem dependências para os
 * serviços de proposta, venda e acompanhamento usarem sem importar um ao outro.
 */
/** Quem tem vê todas as propostas e vendas; quem não tem vê só as suas. */
export const ALL_PROPOSALS_PERMISSION = 'all_propostas';
export type Owner = { userId: number; companyId: number; seesAll: boolean };
/** "Só as minhas": sem a permissão de ver todas, a pessoa enxerga as propostas em que é o vendedor ou que ela criou. */
export function proposalsVisibleTo(actor: Owner): Prisma.Commercial_ProposalWhereInput {
  return actor.seesAll ? {} : { OR: [{ sellerId: actor.userId }, { createdByUserId: actor.userId }] };
}
/** As propostas da pessoa, para filtrar o que se liga a elas (vendas, contatos). Nulo = vê todas. */
export async function ownProposalIds(prisma: PrismaService, actor: Owner): Promise<number[] | null> {
  if (actor.seesAll) return null;
  return (await prisma.commercial_Proposal.findMany({ where: { companyId: actor.companyId, ...proposalsVisibleTo(actor) }, select: { id: true }, take: 5000 })).map((row) => row.id);
}
