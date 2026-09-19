import {
  Actor,
  ActorProvider,
  AuditEntry,
  AuditSink,
  PermissionChecker,
  ScopeResolver,
} from '@adleron/crud-core';
import { Request } from 'express';

import { extractUserPermissions } from 'src/auth/utils/check-permission.util';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Ligação entre o núcleo genérico e este projeto. Tudo que era acoplamento
 * dentro do generic (companyId literal, System_Logs, permissões do JWT) entra
 * aqui por injeção — o núcleo não sabe nada disso.
 */

/** Multi-tenant do WorkSafe: a coluna é `companyId`, vinda do token. */
export const worksafeScope: ScopeResolver<Request> = {
  field: 'companyId',
  resolve: (request) => {
    // Rota pública (vitrine, blog): sem identidade, a empresa vem da query —
    // é o `noCompanyPublic` do generic antigo, agora num lugar só.
    const raw = request['traineeId']
      ? request['student']?.customerId
      : (request.user?.companyId ?? (request.query as Record<string, unknown>)?.companyId);
    return raw === undefined || raw === null || raw === '' ? undefined : Number(raw);
  },
};

/**
 * Identidade do requisitante. Duas convivem no mesmo request — usuário da
 * empresa e aluno — e a distinção passa a ser explícita, em vez de espalhada
 * em `request['traineeId'] || userId` por controller.
 */
export const worksafeActor: ActorProvider<Request> = {
  resolve: (request) => {
    if (request['traineeId']) {
      const actor: Actor = {
        type: 'user',
        id: String(request['traineeId']),
        label: 'aluno',
        scopeId: request['student']?.customerId,
        permissions: [],
      };
      return actor;
    }
    if (!request.user?.sub) return null;
    return {
      type: 'user',
      id: String(request.user.sub),
      scopeId: request.user.companyId,
      permissions: extractUserPermissions(request.user),
      ...(request.ip ? { ip: request.ip } : {}),
    };
  },
};

/** Permissões vêm do JWT (deflate+base64), com a mesma decodificação do AuthGuard. */
export const worksafePermissions: PermissionChecker = {
  has: (actor, permission) => (actor.permissions ?? []).includes(permission),
};

/**
 * Auditoria em `System_Logs`. Diferença para o generic atual: as entradas
 * chegam DENTRO da transação da escrita, e `ipAddress` — coluna que existe no
 * schema e nunca foi preenchida — passa a ser gravada.
 */
export function worksafeAudit(prisma: PrismaService): AuditSink {
  return {
    write: async (entries: AuditEntry[]) => {
      await prisma.system_Logs.createMany({
        data: entries.map((entry) => ({
          companyId: Number(entry.scopeId ?? 0),
          userId: Number(entry.actor.id) || 0,
          action: entry.action,
          entity: entry.entity,
          entityId: Number(entry.entityId) || 0,
          column: entry.column,
          oldValue: entry.oldValue,
          newValue: entry.newValue,
          ipAddress: entry.ip ?? null,
        })),
      });
    },
  };
}
