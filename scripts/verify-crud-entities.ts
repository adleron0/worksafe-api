// Verificação de boot isolada: só as declarações contra o schema real.
import { defineEntity } from '@adleron/crud-core';
import { prismaSchemaProvider } from '@adleron/crud-core/prisma';
import { Prisma } from '@prisma/client';

import { customerEntity } from '../src/features/clientes/customer/rules.crud';
import { ranksEntity } from '../src/features/dom_ranks/rules.crud';

const schema = prismaSchemaProvider(Prisma.dmmf as never);

for (const rules of [customerEntity, ranksEntity]) {
  const def = defineEntity(rules, { schema, scopeField: 'companyId' });
  console.log(`\n✔ ${def.rules.entity}`);
  console.log(`  delegate=${def.delegate}  pk=${def.idField}  escopo=${def.scopeField}  archive=${def.softDeleteField}`);
  console.log(`  rotas: ${def.rules.expose.join(', ')}`);
  console.log(`  graváveis no update: ${[...def.updatableFields].sort().join(', ')}`);
  console.log(`  restritos no update: ${[...def.restrictedUpdateFields].sort().join(', ')}`);
}
