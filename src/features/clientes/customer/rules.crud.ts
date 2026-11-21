import { CrudError, EntityHooks, EntityRules, composeHooks } from '@adleron/crud-core';
import { Request } from 'express';

import { imageUpload, syncActiveFlag } from 'src/common/crud/hooks';
import { isValidCNPJ } from 'src/validators/is-cnpj.constraint';
import { isValidCPF } from 'src/validators/is-cpf.constraint';

/**
 * A coluna `cnpj` guarda o documento do cliente: CNPJ (14 dígitos) para
 * empresa ou CPF (11) para pessoa física (treinamento fechado, serviço para PF).
 * Grava só dígitos e confere os verificadores. Na edição, um documento que não
 * mudou passa sem conferência (há cadastros antigos com CNPJ de teste).
 */
const customerDocument: EntityHooks<Request> = {
  preWrite: ({ op, data, existing }) => {
    if (op !== 'create' && op !== 'update') return undefined;
    if (data.cnpj === undefined) return undefined;
    const digits = String(data.cnpj ?? '').replace(/\D/g, '');
    if (op === 'update' && existing?.cnpj === digits) return { ...data, cnpj: digits };
    if (digits.length === 11) {
      if (!isValidCPF(digits)) throw new CrudError('VALIDATION_FAILED', 'CPF inválido', 'cnpj');
    } else if (digits.length === 14) {
      if (!isValidCNPJ(digits)) throw new CrudError('VALIDATION_FAILED', 'CNPJ inválido', 'cnpj');
    } else {
      throw new CrudError('VALIDATION_FAILED', 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos)', 'cnpj');
    }
    return { ...data, cnpj: digits };
  },
};

/**
 * Cliente — declaração completa da entidade. Substitui controller + service +
 * DTOs de whitelist: a allowlist de gravação é derivada do schema, e as rotas
 * saem do `expose`.
 */
export const customerEntity: EntityRules = {
  entity: 'customer',
  model: 'Customer',

  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
  // O WorkSafe tem permissões separadas para ativar e inativar.
  restorePermission: 'own',
  permissions: {
    list: 'list_clientes',
    getById: 'list_clientes',
    create: 'create_clientes',
    update: 'update_clientes',
    archive: 'inactive_clientes',
    restore: 'activate_clientes',
  },

  filterable: [
    'name',
    'corporateName',
    'cnpj',
    'email',
    'phone',
    'rankId',
    'stateId',
    'cityId',
    'activityType',
    'icmsContributor',
    'createdAt',
  ],
  sortable: ['id', 'name', 'corporateName', 'createdAt'],
  includable: ['rank', 'state', 'city', 'contacts'],
  aggregatable: ['rankId', 'stateId', 'cityId'],

  // `active` e `searchName` são do servidor: `active` só muda pelas rotas de
  // arquivamento (o UpdateDto antigo o aceitava no corpo) e `searchName` é
  // derivado. O formulário do front não envia nenhum dos dois.
  neverWritable: ['active', 'searchName'],
  softDelete: { field: 'inactiveAt' },

  // `active`+`inactiveAt` em sincronia e upload da imagem (FileInterceptor no módulo).
  hooks: composeHooks(syncActiveFlag, customerDocument, imageUpload()),
};

/**
 * Duplicidade de CNPJ por empresa tem constraint no banco
 * (`@@unique([cnpj, companyId])`), então o P2002 já vira 409 pelo adapter.
 * Este helper só existe para a mensagem de domínio, quando for preciso.
 */
export function duplicateCustomerError(): CrudError {
  return new CrudError('CONFLICT', 'Já existe um cliente com este CPF/CNPJ', 'cnpj');
}
