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
import { DynamicModule, Module, Type } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { Request } from 'express';

import { Public } from 'src/auth/decorators/public.decorator';
import { AuthCacheService } from 'src/common/cache/auth-cache.service';
import { AsaasModule } from 'src/common/gateways/asaas/asaas.module';
import { AsaasService } from 'src/common/gateways/asaas/asaas.service';
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
      return createCrudController(defineWorksafeEntity(rules), {
        ...controller,
        // O AuthGuard global do projeto lê @Public(); ops em publicOps recebem-no.
        publicDecorator: Public(),
      });
    });
    return {
      module: CrudModule,
      imports: [PrismaModule, AsaasModule, ...extraImports],
      controllers: [...controllers, ...extraControllers],
      providers: [
        {
          provide: CrudService,
          inject: [PrismaService, AuthCacheService, AsaasService],
          useFactory: (prisma: PrismaService, authCache: AuthCacheService, asaas: AsaasService) =>
            new CrudService<Request>({
              repository: prismaRepository(prisma as never),
              scope: worksafeScope,
              actor: worksafeActor,
              audit: worksafeAudit(prisma),
              permissions: worksafePermissions,
              // Disponíveis em todo hook como `deps.*` — DI de verdade, não singletons.
              hookDeps: { prisma, authCache, asaas },
            }),
        },
        { provide: APP_FILTER, useClass: CrudErrorFilter },
      ],
    };
  }
}
