/**
 * Registro das entidades servidas pelo núcleo genérico (@adleron/crud-core).
 * Cada linha é uma entidade: as regras e, quando preciso, os decorators por
 * op (upload, cache, evicção) — concerns do projeto, fora do núcleo.
 */
import { UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { AIModule } from 'src/common/ai';
import { Cache, CacheEvictAll } from 'src/common/cache';
import { ImageOptimizationInterceptor } from 'src/features/upload/image-optimization.interceptor';
import { UploadModule } from 'src/features/upload/upload.module';
import { getMulterOptions, getOptimizedMulterOptions } from 'src/features/upload/upload.middleware';

import { blogCategoryEntity } from 'src/features/blog/category/rules.crud';
import { CommentCustomController } from 'src/features/blog/comment/custom.controller';
import { CommentModule } from 'src/features/blog/comment/module';
import { blogCommentEntity } from 'src/features/blog/comment/rules.crud';
import { PostCustomController } from 'src/features/blog/post/custom.controller';
import { PostModule } from 'src/features/blog/post/module';
import { blogPostEntity } from 'src/features/blog/post/rules.crud';
import { blogTagEntity } from 'src/features/blog/tag/rules.crud';
import { VisitorCustomController } from 'src/features/blog/visitor/custom.controller';
import { blogVisitorEntity } from 'src/features/blog/visitor/rules.crud';
import { customerEntity } from 'src/features/clientes/customer/rules.crud';
import { citiesEntity } from 'src/features/dom_cities/rules.crud';
import { ranksEntity } from 'src/features/dom_ranks/rules.crud';
import { rolesEntity } from 'src/features/dom_roles/rules.crud';
import { statesEntity } from 'src/features/dom_states/rules.crud';
import { siteProductsEntity } from 'src/features/site/site_loja/rules.crud';
import { siteServicesEntity } from 'src/features/site/site_services/rules.crud';
import { couponEntity } from 'src/features/training/coupon/rules.crud';
import { instructorEntity } from 'src/features/training/instructor/rules.crud';
import { InstructorSignatureController } from 'src/features/training/instructor/signature.controller';
import { userEntity } from 'src/features/users/user/rules.crud';
import { CrudEntity } from './crud.module';

const upload = (folder: string) => UseInterceptors(FileInterceptor('image', getMulterOptions(folder)));
const uploadOptimized = UseInterceptors(FileInterceptor('image', getOptimizedMulterOptions()));
const uploadCover = UseInterceptors(FileInterceptor('image', getOptimizedMulterOptions()), ImageOptimizationInterceptor);
const evict = (prefix: string, route: string) => CacheEvictAll(`${prefix}:*`, `cache:*/${route}*`);
const evictSiteServices = evict('site-services', 'site-services');
const blogEvict = (name: string) =>
  CacheEvictAll(`blog/${name}:*`, `blog-${name}-public:*`, `cache:*/blog/${name}*`, `cache:*/blog-${name}-public*`);
const postEvict = CacheEvictAll(
  'blog/posts:*', 'blog-posts-public:*', 'blog-post-slug:*',
  'cache:*/blog/posts*', 'cache:*/blog-posts-public*', 'cache:*/blog-post-slug*',
);
const blogCrud = (rules: CrudEntity['rules'], name: string): CrudEntity => ({
  rules,
  controller: {
    prefix: 'blog',
    decorators: {
      list: [Cache({ prefix: `blog/${name}`, ttl: 3600 })],
      listPublic: [Cache({ prefix: `blog-${name}-public`, ttl: 3600 })],
      create: [blogEvict(name)], update: [blogEvict(name)],
      archive: [blogEvict(name)], restore: [blogEvict(name)],
    },
  },
});

export const crudEntities: CrudEntity[] = [
  { rules: userEntity, controller: { decorators: {
    create: [upload('user-profile')], update: [upload('user-profile')], updateSelf: [upload('user-profile')] } } },
  { rules: customerEntity, controller: { decorators: {
    create: [upload('custumer-logo')], update: [upload('custumer-logo')] } } },
  { rules: ranksEntity },
  { rules: rolesEntity },
  { rules: statesEntity },
  { rules: citiesEntity },
  { rules: siteServicesEntity, controller: { decorators: {
    list: [Cache({ prefix: 'site-services', ttl: 172800 })],
    create: [upload('services-image'), evictSiteServices],
    update: [upload('services-image'), evictSiteServices],
    archive: [evictSiteServices], restore: [evictSiteServices],
  } } },
  { rules: siteProductsEntity, controller: { decorators: {
    list: [Cache({ prefix: 'site-products', ttl: 172800 })],
    create: [upload('site_products-image'), evict('site-products', 'site-products')],
    update: [upload('site_products-image'), evict('site-products', 'site-products')],
    archive: [evict('site-products', 'site-products')], restore: [evict('site-products', 'site-products')],
  } } },
  { rules: instructorEntity, controller: { decorators: { create: [uploadOptimized], update: [uploadOptimized] } } },
  { rules: couponEntity, controller: { decorators: {
    create: [evict('coupon', 'coupon')], update: [evict('coupon', 'coupon')],
    archive: [evict('coupon', 'coupon')], restore: [evict('coupon', 'coupon')],
  } } },
  blogCrud(blogTagEntity, 'tags'),
  blogCrud(blogCategoryEntity, 'categories'),
  { rules: blogPostEntity, controller: { prefix: 'blog', decorators: {
    list: [Cache({ prefix: 'blog/posts', ttl: 1800 })],
    listPublic: [Cache({ prefix: 'blog-posts-public', ttl: 1800 })],
    create: [uploadCover, postEvict], update: [uploadCover, postEvict],
    archive: [postEvict], restore: [postEvict],
  } } },
  { rules: blogCommentEntity, controller: { prefix: 'blog' } },
  { rules: blogVisitorEntity, controller: { prefix: 'blog' } },
];

/** Rotas custom que reusam o CrudService (fora da fábrica, explícitas). */
export const crudExtraControllers = [
  InstructorSignatureController,
  PostCustomController,
  CommentCustomController,
  VisitorCustomController,
];

/** Módulos que os controllers custom precisam (services de domínio, IA). */
export const crudExtraImports = [PostModule, CommentModule, AIModule, UploadModule];
