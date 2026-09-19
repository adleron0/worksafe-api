// Verificação de boot isolada: só as declarações contra o schema real.
import { defineEntity } from '@adleron/crud-core';
import { prismaSchemaProvider } from '@adleron/crud-core/prisma';
import { Prisma } from '@prisma/client';

import { customerEntity } from '../src/features/clientes/customer/rules.crud';
import { ranksEntity } from '../src/features/dom_ranks/rules.crud';
import { rolesEntity } from '../src/features/dom_roles/rules.crud';
import { statesEntity } from '../src/features/dom_states/rules.crud';
import { citiesEntity } from '../src/features/dom_cities/rules.crud';
import { siteServicesEntity } from '../src/features/site/site_services/rules.crud';
import { siteProductsEntity } from '../src/features/site/site_loja/rules.crud';
import { instructorEntity } from '../src/features/training/instructor/rules.crud';
import { couponEntity } from '../src/features/training/coupon/rules.crud';
import { blogTagEntity } from '../src/features/blog/tag/rules.crud';
import { blogCategoryEntity } from '../src/features/blog/category/rules.crud';

const schema = prismaSchemaProvider(Prisma.dmmf as never);

for (const rules of [customerEntity, ranksEntity, rolesEntity, statesEntity, citiesEntity, siteServicesEntity, siteProductsEntity, instructorEntity, couponEntity, blogTagEntity, blogCategoryEntity]) {
  const def = defineEntity(rules, { schema, scopeField: 'companyId' });
  console.log(`\n✔ ${def.rules.entity}`);
  console.log(`  delegate=${def.delegate}  pk=${def.idField}  escopo=${def.scopeField}  archive=${def.softDeleteField}`);
  console.log(`  rotas: ${def.rules.expose.join(', ')}`);
  console.log(`  graváveis no update: ${[...def.updatableFields].sort().join(', ')}`);
  console.log(`  restritos no update: ${[...def.restrictedUpdateFields].sort().join(', ')}`);
}
