import { CrudError, EntityRules, composeHooks } from '@adleron/crud-core';
import { Request } from 'express';
import { CacheService } from 'src/common/cache/cache.service';
import { AsaasService } from 'src/common/gateways/asaas/asaas.service';
import { parseJsonFields, syncActiveFlag } from 'src/common/crud/hooks';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Configuração de gateway por empresa. O rules.ts antigo instanciava
 * AsaasService/CacheService via setters globais; aqui vêm por deps (DI). Ao
 * salvar um token do Asaas, cacheia e (re)configura o webhook no gateway.
 */
async function configureWebhook(deps: Record<string, unknown>, gateway: string, payload: Record<string, any>, companyId: number, currentWebhookId?: string) {
  if (gateway !== 'asaas' || !payload?.token) return payload;
  const asaas = deps.asaas as AsaasService;
  const cache = deps.cache as CacheService;
  try {
    await cache.set(`asaasToken:${companyId}`, payload.token, 2592000);
    const webhook = await asaas.configureWebhooks(companyId, currentWebhookId || payload.webhookId || null);
    if (webhook?.id) return { ...payload, webhookId: webhook.id };
  } catch (error) {
    console.error('[company-gateways] falha ao configurar webhook Asaas:', (error as Error).message);
  }
  return payload;
}

export const companyGatewayEntity: EntityRules = {
  entity: 'company-gateways', model: 'CompanyGateWays',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: { list: 'list_integracoes', getById: 'list_integracoes', create: 'create_integracoes',
    update: 'update_integracoes', archive: 'inactive_integracoes', restore: 'activate_integracoes' },
  filterable: ['gateway', 'createdAt'], sortable: ['id', 'gateway', 'createdAt'],
  neverWritable: ['active'], softDelete: { field: 'inactiveAt' },
  hooks: composeHooks<Request>(syncActiveFlag, parseJsonFields('payload'), {
    preWrite: async ({ op, data, existing, scopeId, deps }) => {
      const prisma = deps.prisma as PrismaService;
      const companyId = Number(scopeId);
      if (op === 'create') {
        // sem unique no schema: um gateway por empresa
        const dup = await prisma.companyGateWays.findFirst({ where: { companyId, gateway: data.gateway as never }, select: { id: true } });
        if (dup) throw new CrudError('CONFLICT', 'Gateway já configurado para esta empresa', 'gateway');
        if (data.payload) return { ...data, payload: await configureWebhook(deps, String(data.gateway), data.payload as never, companyId) };
      }
      if (op === 'update' && data.payload && existing) {
        const current = (typeof existing.payload === 'string' ? JSON.parse(existing.payload as string) : existing.payload) ?? {};
        return { ...data, payload: await configureWebhook(deps, String(existing.gateway), data.payload as never, companyId, current.webhookId) };
      }
      return undefined;
    },
  }),
};
