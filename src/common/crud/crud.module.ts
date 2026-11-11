import {
  CrudService,
  DEFAULT_RESERVED_KEYS,
  EntityDefinition,
  EntityRules,
  defineEntity,
} from '@adleron/crud-core';
import { prismaRepository, prismaSchemaProvider } from '@adleron/crud-core/prisma';
import {
  createCrudController,
  CrudControllerOptions,
  CrudErrorFilter,
} from '@adleron/crud-core/nestjs';
import { DynamicModule, Module, Type, UseInterceptors } from '@nestjs/common';
import { NoFilesInterceptor } from '@nestjs/platform-express';
import { APP_FILTER } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { Request } from 'express';

import { Public } from 'src/auth/decorators/public.decorator';
import { AuthCacheService } from 'src/common/cache/auth-cache.service';
import { CacheService } from 'src/common/cache/cache.service';
import { AsaasModule } from 'src/common/gateways/asaas/asaas.module';
import { AsaasService } from 'src/common/gateways/asaas/asaas.service';
import { PaymentsModule } from 'src/payments/payments.module';
import { GatewayCredentialsService } from 'src/payments/application/gateway-credentials.service';
import { SellerAccountService } from 'src/payments/application/seller-account.service';
import { ClassGatewayValidator } from 'src/payments/application/class-gateway-validator.service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  worksafeActor,
  worksafeAudit,
  worksafePermissions,
  worksafeScope,
} from './worksafe-ports';

const schema = prismaSchemaProvider(Prisma.dmmf as never);

/** Compila a declaração no boot: rules inválida = BootError e a app não sobe. */
export function defineWorksafeEntity(rules: EntityRules): EntityDefinition {
  // maxLimit 1000: o front usa limit=1000 em várias listagens.
  return defineEntity(rules, {
    schema,
    scopeField: worksafeScope.field,
    maxLimit: 1000,
    // `companyId` é escopo, nunca filtro livre (rotas públicas o mandam na query).
    reservedKeys: [...DEFAULT_RESERVED_KEYS, 'companyId'],
  });
}

/**
 * O front envia toda escrita como multipart/form-data. Sem um interceptor do
 * multer o corpo nem é parseado — os controllers antigos tinham
 * FileInterceptor em toda rota de escrita só por isso. Decorator de upload
 * marcado com `multipart()` substitui o parser padrão; sem ele, entra o
 * NoFilesInterceptor (campos sim, arquivo inesperado = 400).
 */
const MULTIPART = Symbol.for('worksafe.crud.multipart');
export function multipart(decorator: MethodDecorator): MethodDecorator {
  return Object.assign(decorator, { [MULTIPART]: true });
}
const isMultipart = (d: MethodDecorator) => Boolean((d as unknown as Record<symbol, unknown>)[MULTIPART]);
const WRITE_OPS = ['create', 'update', 'updateSelf', 'upsert'] as const;

/** Uma entidade a registrar: as regras e, opcionalmente, decorators por op. */
export interface CrudEntity {
  rules: EntityRules;
  controller?: Omit<CrudControllerOptions, 'publicDecorator'>;
}

/**
 * Registra um controller CRUD por entidade declarada. Só as ops do `expose`
 * viram rota — não existe classe base com rota herdada.
 */
@Module({})
export class CrudModule {
  /**
   * `extraControllers`: rotas custom que reusam o CrudService (ex.:
   * PUT /instructors/:id/signature). Ficam explícitas, fora da fábrica.
   */
  static forEntities(
    entities: Array<EntityRules | CrudEntity>,
    extraControllers: Type<unknown>[] = [],
    extraImports: DynamicModule['imports'] = [],
  ): DynamicModule {
    const controllers = entities.map((entry) => {
      const { rules, controller } = 'rules' in entry ? entry : { rules: entry, controller: undefined };
      const decorators = { ...(controller?.decorators ?? {}) };
      for (const op of WRITE_OPS) {
        if (!rules.expose.includes(op)) continue;
        const list = decorators[op] ?? [];
        if (!list.some(isMultipart)) decorators[op] = [UseInterceptors(NoFilesInterceptor()), ...list];
      }
      return createCrudController(defineWorksafeEntity(rules), {
        ...controller,
        decorators,
        // O AuthGuard global do projeto lê @Public(); ops em publicOps recebem-no.
        publicDecorator: Public(),
        // CacheEvictAll do projeto lê this.cacheService.
        properties: { cacheService: CacheService },
      });
    });
    return {
      module: CrudModule,
      imports: [PrismaModule, AsaasModule, PaymentsModule, ...extraImports],
      // Custom ANTES dos gerados: rotas estáticas (/list, /public, /my-courses)
      // têm de ser registradas antes do `GET /:id` da fábrica, senão "list"
      // vira um id e cai no getById.
      controllers: [...extraControllers, ...controllers],
      providers: [
        {
          provide: CrudService,
          inject: [PrismaService, AuthCacheService, AsaasService, CacheService, GatewayCredentialsService, SellerAccountService, ClassGatewayValidator],
          useFactory: (
            prisma: PrismaService, authCache: AuthCacheService, asaas: AsaasService, cache: CacheService,
            credentials: GatewayCredentialsService, sellerAccounts: SellerAccountService, classGatewayValidator: ClassGatewayValidator,
          ) =>
            new CrudService<Request>({
              repository: prismaRepository(prisma as never),
              scope: worksafeScope,
              actor: worksafeActor,
              audit: worksafeAudit(prisma),
              permissions: worksafePermissions,
              // Disponíveis em todo hook como `deps.*` — DI de verdade, não singletons.
              hookDeps: { prisma, authCache, asaas, cache, credentials, sellerAccounts, classGatewayValidator },
            }),
        },
        { provide: APP_FILTER, useClass: CrudErrorFilter },
      ],
    };
  }
}
