import { EntityRules, composeHooks } from '@adleron/crud-core';

import { fileUpload, parseJsonFields, syncActiveFlag } from 'src/common/crud/hooks';

/**
 * A própria empresa (tenant). O escopo é a PK: cada usuário só lê/edita a
 * sua — antes, `GET /companies` com noCompany=true listava TODAS e o update
 * dependia de um hook lembrar de comparar o id. A vitrine (`/public`) é
 * consultada pelo site por lp_domain/system_domain.
 */
export const companyEntity: EntityRules = {
  entity: 'companies',
  scopeField: 'id', // cada empresa só enxerga e edita a si mesma
  model: 'Company',
  expose: ['list', 'getById', 'update', 'listPublic'],
  permissions: { list: 'list_company', getById: 'list_company', update: 'update_company' },
  filterable: ['comercial_name', 'lp_domain', 'system_domain', 'cnpj'],
  sortable: ['id', 'comercial_name'],
  includable: ['state', 'city', 'products'],
  includes: { products: { include: { product: true } } },
  // Dados financeiros e SMTP nunca saem na vitrine (o admin da empresa vê).
  publicMaskedFields: ['id', 'financial_email', 'financial_contact', 'email_conection'],
  neverWritable: ['active', 'cnpj'],
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(
    syncActiveFlag,
    fileUpload({ logo: 'logoUrl', favicon: 'faviconUrl' }),
    parseJsonFields('email_conection'),
  ),
};
