/* eslint-disable no-console */
/**
 * gen:entity — gera a declaração `rules.crud.ts` de uma entidade a partir do
 * schema Prisma, já válida para o @adleron/crud-core.
 *
 *   npm run gen:entity -- <Model> <rota> <permissao> [pasta]
 *   ex.: npm run gen:entity -- DOM_Equipaments equipaments equipamentos features/dom_equipaments
 *
 * Substitui o gerador antigo, que emitia controller+service+module+DTOs+rules
 * herdando o GenericController. Agora a entidade é uma declaração: depois de
 * gerar, registre-a em src/common/crud/entities.registry.ts.
 */
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const [model, route, permission, folder] = process.argv.slice(2);
if (!model || !route || !permission) {
  console.error('uso: gen:entity <Model> <rota> <permissao> [pasta]');
  process.exit(1);
}
const dmmf = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
if (!dmmf) {
  console.error(`model '${model}' não existe no schema`);
  process.exit(1);
}

const scalars = dmmf.fields.filter((f) => f.kind !== 'object' && !f.isList);
const names = new Set(scalars.map((f) => f.name));
const has = (n: string) => names.has(n);
const camel = model.charAt(0).toLowerCase() + model.slice(1);
const exportName = `${camel}Entity`;

const filterable = scalars
  .filter((f) => !['id', 'password', 'companyId', 'inactiveAt', 'updatedAt'].includes(f.name) && f.type !== 'Json')
  .map((f) => f.name);
const sortable = ['id', ...scalars.filter((f) => ['String', 'Int', 'DateTime', 'Decimal'].includes(f.type) && !['password', 'companyId', 'imageUrl'].includes(f.name)).map((f) => f.name).slice(0, 4)];
const relations = dmmf.fields.filter((f) => f.kind === 'object').map((f) => f.name);
const jsonFields = scalars.filter((f) => f.type === 'Json').map((f) => f.name);
const softDelete = has('inactiveAt') ? "softDelete: { field: 'inactiveAt' }," : has('archivedAt') ? "softDelete: { field: 'archivedAt' }," : '';
const archiveOps = softDelete ? ", 'archive', 'restore'" : '';
const archivePerms = softDelete ? `\n    archive: 'inactive_${permission}', restore: 'activate_${permission}',` : '';
const hooks: string[] = [];
if (has('active')) hooks.push('syncActiveFlag');
if (has('imageUrl')) hooks.push('imageUpload()');
if (has('password')) hooks.push('hashPassword');
if (jsonFields.length) hooks.push(`parseJsonFields(${jsonFields.map((f) => `'${f}'`).join(', ')})`);
const hookImports = ['syncActiveFlag', 'imageUpload', 'hashPassword', 'parseJsonFields'].filter((h) => hooks.some((x) => x.startsWith(h)));

const content = `import { EntityRules${hooks.length > 1 ? ', composeHooks' : ''} } from '@adleron/crud-core';
${hookImports.length ? `import { ${hookImports.join(', ')} } from 'src/common/crud/hooks';\n` : ''}
export const ${exportName}: EntityRules = {
  entity: '${route}',
  model: '${model}',
  expose: ['list', 'getById', 'create', 'update'${archiveOps}],${softDelete ? "\n  restorePermission: 'own'," : ''}
  permissions: {
    list: 'list_${permission}', getById: 'list_${permission}',
    create: 'create_${permission}', update: 'update_${permission}',${archivePerms}
  },
  filterable: [${filterable.map((f) => `'${f}'`).join(', ')}],
  sortable: [${[...new Set(sortable)].map((f) => `'${f}'`).join(', ')}],
  includable: [${relations.map((r) => `'${r}'`).join(', ')}],${has('password') ? "\n  maskedFields: ['password']," : ''}${has('active') ? "\n  neverWritable: ['active']," : ''}
  ${softDelete}${hooks.length ? `\n  hooks: ${hooks.length > 1 ? `composeHooks(${hooks.join(', ')})` : hooks[0]},` : ''}
};
`;

const dir = path.join('src', folder ?? `features/${camel}`);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'rules.crud.ts');
if (fs.existsSync(file)) {
  console.error(`${file} já existe — não sobrescrevo.`);
  process.exit(1);
}
fs.writeFileSync(file, content);
console.log(`✔ ${file}`);
console.log(`→ registre \`${exportName}\` em src/common/crud/entities.registry.ts e rode npm run crud:verify`);
