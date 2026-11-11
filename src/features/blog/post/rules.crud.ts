import { EntityRules, composeHooks } from '@adleron/crud-core';
import { Request } from 'express';

import { fileUpload } from 'src/common/crud/hooks';
import { PrismaService } from 'src/prisma/prisma.service';

export const postIncludes = {
  author: { select: { id: true, name: true, imageUrl: true } },
  category: { select: { id: true, name: true, slug: true } },
  tags: { include: { tag: true } },
  _count: { select: { comments: true } },
};

const tagIdsOf = (request: Request): number[] | undefined => {
  const raw = (request.body as Record<string, unknown> | undefined)?.tagIds;
  if (raw === undefined) return undefined;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? raw.split(',') : [];
  return list.map(Number).filter((n) => Number.isFinite(n));
};

export const blogPostEntity: EntityRules = {
  entity: 'posts', // prefixo 'blog' no módulo → /blog/posts
  model: 'Blog_Post',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore', 'listPublic'],
  restorePermission: 'own',
  permissions: {
    list: 'list_blog', getById: 'list_blog', create: 'create_blog',
    update: 'update_blog', archive: 'inactive_blog', restore: 'activate_blog',
  },
  // O site (worksafe-site) escolhe a empresa pelo domínio: company.lp_domain.
  filterable: ['company.lp_domain', 'title', 'slug', 'status', 'featured', 'categoryId', 'authorId', 'publishedAt', 'createdAt', 'category.slug'],
  sortable: ['id', 'title', 'publishedAt', 'createdAt', 'viewCount'],
  includable: ['author', 'category', 'tags', '_count'],
  includes: postIncludes,
  // `status` muda pelas rotas publish/archive/draft e pelo update do editor.
  statusUpdatable: true,
  neverWritable: ['viewCount'],
  softDelete: { field: 'inactiveAt' },
  hooks: composeHooks<Request>(
    // capa: campo multipart `image` → coverImage
    fileUpload({ image: 'coverImage' }),
    {
      // Vitrine só mostra publicado: em request sem identidade força status.
      preList: ({ context }) =>
        context.user || context['traineeId']
          ? undefined
          : { kind: 'cmp', path: ['status'], operator: 'eq', value: 'published' },
      preWrite: async ({ op, data, existing, context }) => {
        const patched = { ...data };
        if (op === 'create') {
          if (!patched.authorId && context.user?.sub) patched.authorId = Number(context.user.sub);
          if (patched.status === 'published' && !patched.publishedAt) patched.publishedAt = new Date();
        }
        if (op === 'update' && patched.status === 'published' && !existing?.publishedAt) {
          patched.publishedAt = new Date();
        }
        if (op === 'archive') patched.status = 'archived';
        if (patched.featured === '' || patched.featured === undefined) delete patched.featured;
        return patched;
      },
      // Relação N:N com tags: `tagIds` do corpo, sincronizada após a escrita.
      postWrite: async ({ op, result, context, deps }) => {
        if (op !== 'create' && op !== 'update') return;
        const tagIds = tagIdsOf(context);
        if (tagIds === undefined) return;
        const prisma = deps.prisma as PrismaService;
        const postId = Number(result.id);
        await prisma.blog_PostTag.deleteMany({ where: { postId } });
        if (tagIds.length) {
          await prisma.blog_PostTag.createMany({
            data: tagIds.map((tagId) => ({ postId, tagId })),
            skipDuplicates: true,
          });
        }
      },
    },
  ),
};
