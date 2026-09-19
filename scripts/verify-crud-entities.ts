// Verificação de boot isolada: todas as entidades registradas contra o schema real.
import 'tsconfig-paths/register';
import { defineWorksafeEntity } from '../src/common/crud/crud.module';
import { crudEntities } from '../src/common/crud/entities.registry';

for (const { rules } of crudEntities) {
  const def = defineWorksafeEntity(rules);
  console.log(`✔ ${def.rules.entity}`);
  console.log(`  delegate=${def.delegate}  pk=${def.idField}  escopo=${def.scopeField ?? '-'}  archive=${def.softDeleteField ?? '-'}`);
  console.log(`  rotas: ${def.rules.expose.join(', ')}`);
  console.log(`  restritos no update: ${[...def.restrictedUpdateFields].sort().join(', ')}`);
}
console.log(`\n${crudEntities.length} entidades válidas.`);
