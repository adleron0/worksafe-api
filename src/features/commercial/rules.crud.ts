import { CrudError, EntityRules } from '@adleron/crud-core';
import { PrismaService } from 'src/prisma/prisma.service';

const clean = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ');

/** Profissionais (tabela MDO): nome e salário. Custo hora e adicionais saem do motor. */
export const professionalEntity: EntityRules = {
  entity: 'commercial-professionals', model: 'Commercial_Professional',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: {
    list: 'list_comercial', getById: 'list_comercial', create: 'create_comercial',
    update: 'update_comercial', archive: 'inactive_comercial', restore: 'activate_comercial',
  },
  filterable: ['name', 'createdAt'],
  sortable: ['id', 'name', 'salary', 'createdAt'],
  softDelete: { field: 'inactiveAt' },
  hooks: {
    preWrite: async ({ op, data, existing, scopeId, deps }) => {
      if (op !== 'create' && op !== 'update') return undefined;
      const prisma = deps.prisma as PrismaService;
      const next: Record<string, any> = { ...data };
      if ('name' in next || op === 'create') {
        const name = clean(next.name);
        if (name.length < 2) throw new CrudError('VALIDATION_FAILED', 'Informe o nome do profissional', 'name');
        const dup = await prisma.commercial_Professional.findFirst({
          where: { companyId: Number(scopeId), name: { equals: name, mode: 'insensitive' }, ...(existing ? { NOT: { id: Number(existing.id) } } : {}) },
          select: { id: true },
        });
        if (dup) throw new CrudError('CONFLICT', 'Já existe um profissional com esse nome', 'name');
        next.name = name;
      }
      if ('salary' in next || op === 'create') {
        const salary = Number(next.salary);
        if (!Number.isFinite(salary) || salary <= 0) throw new CrudError('VALIDATION_FAILED', 'Informe o salário bruto', 'salary');
        next.salary = Math.round(salary * 100) / 100;
      }
      if ('notes' in next) next.notes = clean(next.notes) || null;
      return next;
    },
  },
};
