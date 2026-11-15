import { CrudError, EntityRules, composeHooks } from '@adleron/crud-core';
import { syncActiveFlag } from 'src/common/crud/hooks';
import { CAPTION_KINDS } from './defaults';

const clean = (value: unknown) => String(value ?? '').trim();

/**
 * Modelos de legenda da divulgação de turmas. O texto usa variáveis
 * `{{curso}}`, `{{datas}}` … resolvidas no navegador com os dados da turma.
 * Ver as variáveis em worksafe-front `treinamentos/_divulgacao/-lib/variables.ts`.
 */
export const marketingCaptionEntity: EntityRules = {
  entity: 'marketing-captions', model: 'Marketing_CaptionTemplate',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: {
    list: 'list_divulgacao', getById: 'list_divulgacao', create: 'update_divulgacao',
    update: 'update_divulgacao', archive: 'update_divulgacao', restore: 'update_divulgacao',
  },
  filterable: ['name', 'kind', 'createdAt'],
  sortable: ['id', 'name', 'sortOrder', 'createdAt'],
  neverWritable: ['active'], softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(syncActiveFlag, {
    preWrite: ({ op, data }) => {
      if (op !== 'create' && op !== 'update') return undefined;
      const next: Record<string, any> = { ...data };
      if ('name' in next || op === 'create') {
        next.name = clean(next.name);
        if (next.name.length < 2) throw new CrudError('VALIDATION_FAILED', 'Informe o nome do modelo', 'name');
      }
      if ('body' in next || op === 'create') {
        next.body = String(next.body ?? '').replace(/\r\n/g, '\n');
        if (!next.body.trim()) throw new CrudError('VALIDATION_FAILED', 'Escreva o texto da legenda', 'body');
      }
      if ('kind' in next && !CAPTION_KINDS.includes(next.kind)) next.kind = 'outro';
      if ('sortOrder' in next) next.sortOrder = Number(next.sortOrder) || 0;
      return next;
    },
  }),
};
