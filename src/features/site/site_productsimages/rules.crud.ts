import { EntityRules, composeHooks } from '@adleron/crud-core';
import { imageUpload, syncActiveFlag } from 'src/common/crud/hooks';

export const siteProductImagesEntity: EntityRules = {
  entity: 'site_productsimages', model: 'Site_ProductsImages',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'], restorePermission: 'own',
  permissions: { list: 'list_loja_site', getById: 'list_loja_site', create: 'create_loja_site',
    update: 'update_loja_site', archive: 'inactive_loja_site', restore: 'activate_loja_site' },
  filterable: ['name', 'productId', 'createdAt'], sortable: ['id', 'name', 'createdAt'],
  includable: ['product'], neverWritable: ['active'], softDelete: { field: 'inactiveAt' },
  hooks: composeHooks(syncActiveFlag, imageUpload()),
};
