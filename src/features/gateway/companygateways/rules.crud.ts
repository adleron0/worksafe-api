import { CrudError, EntityRules, composeHooks } from '@adleron/crud-core';
import { Request } from 'express';
import { parseJsonFields, syncActiveFlag } from 'src/common/crud/hooks';
import { GatewayCredentialsService } from 'src/payments/application/gateway-credentials.service';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Configuração de gateway por empresa. Quem sabe aquecer a credencial e
 * registrar o webhook (com authToken) é o adapter do gateway, via
 * GatewayCredentialsService — esta entidade não conhece fornecedor.
 */
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
        if (data.payload) {
          const credentials = deps.credentials as GatewayCredentialsService;
          return { ...data, payload: await credentials.configure({ gateway: data.gateway as never, payload: credentials.parsePayload(data.payload), companyId }) };
        }
      }
      if (op === 'update' && data.payload && existing) {
        const credentials = deps.credentials as GatewayCredentialsService;
        const current = credentials.parsePayload(existing.payload) ?? {};
        // O front reenvia só a chave: preserva webhookId/webhookToken já
        // registrados para não trocar o token do webhook a cada save.
        const incoming = { webhookId: current.webhookId, webhookToken: current.webhookToken, ...credentials.parsePayload(data.payload) };
        return { ...data, payload: await credentials.configure({ gateway: existing.gateway as never, payload: incoming, companyId, currentWebhookId: current.webhookId }) };
      }
      return undefined;
    },
  }),
};
