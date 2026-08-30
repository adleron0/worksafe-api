import {
  CrudService,
  EntityDefinition,
  EntityRules,
  defineEntity,
} from '@adleron/crud-core';
import { prismaRepository, prismaSchemaProvider } from '@adleron/crud-core/prisma';
import { createCrudController, CrudErrorFilter } from '@adleron/crud-core/nestjs';
import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { Request } from 'express';

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
  return defineEntity(rules, { schema, scopeField: worksafeScope.field });
}

/**
 * Registra um controller CRUD por entidade declarada. Só as ops do `expose`
 * viram rota — não existe classe base com rota herdada.
 */
@Module({})
export class CrudModule {
  static forEntities(rules: EntityRules[]): DynamicModule {
    const definitions = rules.map(defineWorksafeEntity);
    return {
      module: CrudModule,
      imports: [PrismaModule],
      controllers: definitions.map((def) => createCrudController(def)),
      providers: [
        {
          provide: CrudService,
          inject: [PrismaService],
          useFactory: (prisma: PrismaService) =>
            new CrudService<Request>({
              repository: prismaRepository(prisma as never),
              scope: worksafeScope,
              actor: worksafeActor,
              audit: worksafeAudit(prisma),
              permissions: worksafePermissions,
            }),
        },
        { provide: APP_FILTER, useClass: CrudErrorFilter },
      ],
    };
  }
}
