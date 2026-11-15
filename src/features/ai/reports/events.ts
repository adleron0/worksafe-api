import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Gatilhos por evento da agenda dos bots. Cada detector olha o que aconteceu
 * desde o último cursor e devolve as ocorrências com uma chave única (para não
 * disparar duas vezes) e um texto que vai para o assistente, com os ids que ele
 * precisa para agir.
 */
export interface EventOccurrence { key: string; at: Date; text: string }
export interface EventDetector {
  label: string;
  description: string;
  params?: { name: string; label: string; type: 'number' | 'text'; default?: number | string; options?: { id: string; name: string }[] }[];
  detect: (prisma: PrismaService, companyId: number, since: Date, params: Record<string, any>) => Promise<EventOccurrence[]>;
}

const iso = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : '—');
const br = (value: Date | null | undefined) => (value ? iso(value).split('-').reverse().join('/') : '—');
const money = (value: unknown) => Number(value ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const todayBr = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const LIMIT = 30;

const ORDER_STAGES = [
  { id: 'a_planejar', name: 'A planejar' }, { id: 'agendada', name: 'Agendada' }, { id: 'em_execucao', name: 'Em execução' },
  { id: 'concluida', name: 'Concluída' }, { id: 'encerrada', name: 'Encerrada' }, { id: 'cancelada', name: 'Cancelada' },
];

export const EVENT_DETECTORS: Record<string, EventDetector> = {
  proposta_aceita: {
    label: 'Proposta aceita',
    description: 'Quando um cliente aceita uma proposta (pelo link ou marcada na tela).',
    detect: async (prisma, companyId, since) => {
      const rows = await prisma.commercial_ProposalEvent.findMany({
        where: { companyId, type: 'aceita', createdAt: { gt: since } }, orderBy: { createdAt: 'asc' }, take: LIMIT,
        select: { id: true, createdAt: true, name: true, proposal: { select: { id: true, number: true, title: true, total: true, customer: { select: { name: true } } } } },
      });
      return rows.map((row) => ({
        key: `proposta:${row.proposal.id}:${row.id}`, at: row.createdAt,
        text: `Proposta ${row.proposal.number} (id ${row.proposal.id}) — "${row.proposal.title}", cliente ${row.proposal.customer?.name ?? '—'}, ${money(row.proposal.total)}, aceita em ${br(row.createdAt)}${row.name ? ` por ${row.name}` : ''}.`,
      }));
    },
  },
  os_mudou_etapa: {
    label: 'OS mudou de etapa',
    description: 'Quando uma ordem de serviço passa de etapa (opcional: só para uma etapa).',
    params: [{ name: 'etapa', label: 'Só quando for para', type: 'text', options: ORDER_STAGES }],
    detect: async (prisma, companyId, since, params) => {
      const rows = await prisma.flow_Event.findMany({
        where: { companyId, entity: 'service_order', createdAt: { gt: since }, toStage: params.etapa ? String(params.etapa) : { not: null } },
        orderBy: { createdAt: 'asc' }, take: LIMIT,
      });
      const orders = await prisma.service_Order.findMany({ where: { id: { in: rows.map((row) => row.entityId) }, companyId }, select: { id: true, number: true, title: true } });
      const order = new Map(orders.map((item) => [item.id, item]));
      return rows.map((row) => ({
        key: `os:${row.id}`, at: row.createdAt,
        text: `OS ${order.get(row.entityId)?.number ?? row.entityId} (id ${row.entityId}) — "${order.get(row.entityId)?.title ?? ''}" passou de "${row.fromStage ?? '—'}" para "${row.toStage}"${row.note ? ` (${row.note})` : ''}.`,
      }));
    },
  },
  documento_vencendo: {
    label: 'Documento vai vencer',
    description: 'Quando um documento de funcionário entra na janela de vencimento (padrão: 30 dias antes).',
    params: [{ name: 'dias', label: 'Dias antes', type: 'number', default: 30 }],
    detect: async (prisma, companyId, _since, params) => {
      const days = Math.min(180, Math.max(1, Number(params.dias) || 30));
      const today = new Date(`${todayBr()}T00:00:00Z`);
      const limit = new Date(today.getTime() + days * 86400000);
      const rows = await prisma.hr_EmployeeDocument.findMany({
        where: { companyId, inactiveAt: null, expiryDate: { gte: today, lte: limit }, employee: { inactiveAt: null } },
        orderBy: { expiryDate: 'asc' }, take: LIMIT,
        select: { id: true, expiryDate: true, employee: { select: { id: true, name: true } }, type: { select: { name: true } } },
      });
      return rows.map((row) => ({
        key: `doc:${row.id}:${iso(row.expiryDate)}`, at: new Date(),
        text: `${row.type.name} de ${row.employee.name} (funcionário id ${row.employee.id}) vence em ${br(row.expiryDate)}.`,
      }));
    },
  },
  turma_lotada: {
    label: 'Turma lotou',
    description: 'Quando uma turma com limite de vagas atinge o total de inscritos confirmados.',
    detect: async (prisma, companyId) => {
      const rows = await prisma.courseClass.findMany({
        where: { companyId, inactiveAt: null, unlimitedSubscriptions: false, maxSubscriptions: { gt: 0 }, OR: [{ finalDate: null }, { finalDate: { gte: new Date(`${todayBr()}T00:00:00Z`) } }] },
        select: { id: true, name: true, maxSubscriptions: true, initialDate: true, course: { select: { name: true } }, _count: { select: { subscriptions: { where: { subscribeStatus: 'confirmed', inactiveAt: null } } } } },
        take: 200,
      });
      return rows.filter((row) => row._count.subscriptions >= (row.maxSubscriptions ?? 0)).slice(0, LIMIT).map((row) => ({
        key: `turma:${row.id}`, at: new Date(),
        text: `A turma "${row.name}" (id ${row.id}, curso ${row.course?.name ?? '—'}, início ${br(row.initialDate)}) lotou: ${row._count.subscriptions} de ${row.maxSubscriptions} vagas.`,
      }));
    },
  },
  despesa_sem_categoria: {
    label: 'Despesa sem categoria',
    description: 'Quando entra uma conta a pagar sem conta do plano de contas.',
    detect: async (prisma, companyId, since) => {
      const rows = await prisma.financial_Payable.findMany({
        where: { companyId, inactiveAt: null, chartAccountId: null, createdAt: { gt: since } }, orderBy: { createdAt: 'asc' }, take: LIMIT,
        select: { id: true, description: true, value: true, dueDate: true, createdAt: true, supplier: { select: { name: true } } },
      });
      return rows.map((row) => ({
        key: `pagar:${row.id}`, at: row.createdAt,
        text: `Conta a pagar id ${row.id} — "${row.description}"${row.supplier ? ` (${row.supplier.name})` : ''}, ${money(row.value)}, vence ${br(row.dueDate)}, sem categoria.`,
      }));
    },
  },
  pagamento_recebido: {
    label: 'Pagamento recebido',
    description: 'Quando uma conta a receber é recebida.',
    detect: async (prisma, companyId, since) => {
      const rows = await prisma.financialRecords.findMany({
        where: { companyId, status: 'received', paidAt: { gt: since } }, orderBy: { paidAt: 'asc' }, take: LIMIT,
        select: { id: true, description: true, value: true, paidAt: true, customer: { select: { name: true } }, trainee: { select: { name: true } } },
      });
      return rows.map((row) => ({
        key: `receber:${row.id}`, at: row.paidAt ?? new Date(),
        text: `Conta a receber id ${row.id} — "${row.description ?? ''}" de ${row.customer?.name ?? row.trainee?.name ?? '—'}, ${money(row.value)}, recebida em ${br(row.paidAt)}.`,
      }));
    },
  },
  inscricao_nova: {
    label: 'Nova inscrição confirmada',
    description: 'Quando uma inscrição em turma é confirmada.',
    detect: async (prisma, companyId, since) => {
      const rows = await prisma.courseClassSubscription.findMany({
        where: { companyId, subscribeStatus: 'confirmed', inactiveAt: null, OR: [{ confirmedAt: { gt: since } }, { confirmedAt: null, updatedAt: { gt: since } }] },
        orderBy: { id: 'asc' }, take: LIMIT,
        select: { id: true, name: true, confirmedAt: true, updatedAt: true, class: { select: { id: true, name: true } } },
      });
      return rows.map((row) => ({
        key: `inscricao:${row.id}`, at: row.confirmedAt ?? row.updatedAt,
        text: `Inscrição id ${row.id}: ${row.name} na turma "${row.class?.name ?? '—'}" (id ${row.class?.id ?? '—'}), confirmada em ${br(row.confirmedAt ?? row.updatedAt)}.`,
      }));
    },
  },
};
