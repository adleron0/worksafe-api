import { CrudError, EntityRules, composeHooks } from '@adleron/crud-core';
import { imageUpload, parseJsonFields, syncActiveFlag } from 'src/common/crud/hooks';
import { ClassGatewayValidator } from 'src/payments/application/class-gateway-validator.service';
import { LANDING_CONTENT_MAX_BYTES, layoutList, layoutOrNull } from '../landing/landing.rules';

/** Página de inscrição: layout fixo, layouts do teste A/B e conteúdo (blocos). */
const landingFields = {
  preWrite: ({ op, data }: any) => {
    if (op !== 'create' && op !== 'update') return undefined;
    const patched = { ...data };
    if ('landingLayout' in patched) patched.landingLayout = layoutOrNull(patched.landingLayout);
    if ('landingAbLayouts' in patched) patched.landingAbLayouts = layoutList(patched.landingAbLayouts);
    if ('landingAbTest' in patched && typeof patched.landingAbTest === 'string') patched.landingAbTest = patched.landingAbTest === 'true';
    if ('landingContent' in patched) {
      const content = patched.landingContent;
      if (content === null || content === 'null') patched.landingContent = null;
      else if (typeof content !== 'object' || Array.isArray(content)) delete patched.landingContent;
      else if (JSON.stringify(content).length > LANDING_CONTENT_MAX_BYTES) {
        throw new CrudError('VALIDATION_FAILED', 'Conteúdo da página grande demais (use imagens enviadas, não coladas)', 'landingContent');
      }
    }
    return patched;
  },
};

const pick = (data: Record<string, any>, existing: Record<string, any> | undefined, field: string) =>
  field in data ? data[field] : existing?.[field];

/**
 * Valida a configuração de pagamento contra o provedor da turma no ESTADO
 * FINAL (existing + data): um update parcial pode trocar só o provedor e
 * deixar métodos incompatíveis já salvos. Erro aparece para quem monta a
 * turma, não para o comprador na hora de pagar.
 */
const gatewayCompatibility = {
  preWrite: async ({ op, data, existing, scopeId, deps }: any) => {
    if (op !== 'create' && op !== 'update') return undefined;
    await (deps.classGatewayValidator as ClassGatewayValidator).validate({
      companyGatewayId: pick(data, existing, 'companyGatewayId'),
      companyId: Number(scopeId),
      allowCheckout: pick(data, existing, 'allowCheckout'),
      paymentMethods: pick(data, existing, 'paymentMethods'),
      dividedIn: pick(data, existing, 'dividedIn'),
    });
    return undefined;
  },
};

const dayOf = (value: unknown) => (value ? new Date(value as string).toISOString().slice(0, 10) : null);
const br = (day: string | null) => (day ? day.split('-').reverse().join('/') : 'sem data');

/**
 * Turma com vagas reservadas para empresas: virar turma fechada não pode (as
 * vagas são avulsas, de turma aberta); mudar a data ou cancelar a turma cria
 * uma tarefa no acompanhamento do cliente para o vendedor avisar a empresa.
 */
const reservationGuards = {
  preWrite: async ({ op, data, existing, deps }: any) => {
    if (op !== 'update' || !existing || !data.customerId || data.customerId === 'null') return undefined;
    const active = await deps.prisma.courseClassReservation.count({ where: { classId: Number(existing.id), inactiveAt: null } });
    if (active) throw new CrudError('CONFLICT', 'A turma tem vagas reservadas para empresas: transfira ou cancele as reservas antes de torná-la fechada', 'customerId');
    return undefined;
  },
  postWrite: async ({ op, result, existing, scopeId, deps, context }: any) => {
    if (!existing || (op !== 'update' && op !== 'archive')) return;
    const before = dayOf(existing.initialDate);
    const after = dayOf(result?.initialDate);
    const cancelled = op === 'archive' || (result?.inactiveAt && !existing.inactiveAt);
    if (!cancelled && before === after) return;
    try {
      const prisma = deps.prisma;
      const reservations = await prisma.courseClassReservation.findMany({ where: { classId: Number(existing.id), inactiveAt: null }, select: { id: true, customerId: true, contractId: true, seats: true } });
      if (!reservations.length) return;
      const contracts = await prisma.commercial_Contract.findMany({ where: { id: { in: reservations.map((r: any) => r.contractId).filter(Boolean) } }, select: { id: true, number: true, sellerId: true } });
      const today = new Date(new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10) + 'T00:00:00.000Z');
      const name = result?.name ?? existing.name;
      for (const r of reservations) {
        const contract = contracts.find((c: any) => c.id === r.contractId);
        const what = cancelled ? `foi cancelada` : `mudou de ${br(before)} para ${br(after)}`;
        await prisma.commercial_Activity.create({ data: {
          companyId: Number(scopeId), customerId: r.customerId, type: 'tarefa',
          subject: cancelled ? 'Turma cancelada: transferir as vagas da empresa' : 'Avisar a empresa: a turma mudou de data',
          notes: `A turma "${name}" ${what}. A empresa tem ${r.seats} vaga(s) reservada(s)${contract ? ` pela venda ${contract.number}` : ''}.` +
            (cancelled ? ' Transfira a reserva para outra turma (Turmas → Vagas de empresas).' : ''),
          dueDate: today, userId: contract?.sellerId ?? null, createdByUserId: Number(context?.user?.sub ?? 0) || null,
        } });
      }
    } catch (error) {
      console.error('[classes] aviso de reservas:', error);
    }
  },
};

/**
 * Turmas. A listagem é pública (site) — o admin usa a mesma rota autenticado,
 * agora escopado pela empresa (antes noCompany=true listava tudo para todos).
 * O include de `course` omite o gabarito (`exam`).
 */
export const classEntity: EntityRules = {
  entity: 'classes', model: 'CourseClass',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
  publicOps: ['list', 'getById'], restorePermission: 'own',
  permissions: { create: 'create_classes', update: 'update_classes', archive: 'inactive_classes', restore: 'activate_classes', },
  // O site (worksafe-site) escolhe a empresa pelo domínio: company.lp_domain.
  filterable: ['id', 'company.lp_domain', 'name', 'courseId', 'customerId', 'certificateId', 'classCode', 'openClass', 'periodClass', 'initialDate', 'finalDate',
    'allowSubscriptions', 'allowCheckout', 'hasOnlineCourse', 'onlineCourseModelId', 'createdAt', 'course.name'],
  sortable: ['id', 'name', 'initialDate', 'finalDate', 'price', 'createdAt'],
  includable: ['instructors', 'course', 'certificate', 'customer', 'onlineCourseModel', '_count'],
  includes: {
    instructors: { include: { instructor: { select: { id: true, name: true, imageUrl: true, active: true, curriculum: true, highlight: true, formation: true, formationCode: true } } } },
    course: { omit: { exam: true }, include: { reviews: {
      select: { generalRating: true, opinionRating: true, authorizationExposeReview: true,
        trainee: { select: { name: true, occupation: true, customer: { select: { name: true } } } } },
      take: 5, orderBy: { generalRating: 'desc' }, where: { authorizationExposeReview: true, inactiveAt: null } } } },
    _count: { select: { subscriptions: { where: { subscribeStatus: 'confirmed' } } } },
  },
  neverWritable: ['active'], softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(syncActiveFlag, imageUpload(), parseJsonFields('faq', 'whyUs', 'landingContent', 'landingAbLayouts'), landingFields, reservationGuards, {
    preWrite: ({ op, data }) => op === 'update'
      ? { ...data, ...('price' in data && !data.price ? { price: null } : {}), ...('discountPrice' in data && !data.discountPrice ? { discountPrice: null } : {}) }
      : undefined,
  }, gatewayCompatibility),
};
