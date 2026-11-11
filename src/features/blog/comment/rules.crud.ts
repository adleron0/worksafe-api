import { CrudError, EntityRules } from '@adleron/crud-core';
import { Request } from 'express';

import { PrismaService } from 'src/prisma/prisma.service';

export const blogCommentEntity: EntityRules = {
  entity: 'comments',
  model: 'Blog_Comment',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore'],
  restorePermission: 'own',
  permissions: {
    list: 'list_blog', getById: 'list_blog', create: 'create_blog',
    update: 'update_blog', archive: 'inactive_blog', restore: 'activate_blog',
  },
  // O site (worksafe-site) escolhe a empresa pelo domínio: company.lp_domain.
  filterable: ['company.lp_domain', 'postId', 'visitorId', 'parentId', 'status', 'rating', 'createdAt', 'visitor.name', 'post.title'],
  sortable: ['id', 'createdAt', 'rating'],
  includable: ['visitor', 'post', 'replies'],
  includes: {
    visitor: { select: { id: true, name: true, email: true, avatarUrl: true, blocked: true } },
    post: { select: { id: true, title: true, slug: true } },
    replies: {
      include: { visitor: { select: { id: true, name: true, email: true, avatarUrl: true } } },
      orderBy: { createdAt: 'asc' },
    },
  },
  // moderação (approve/disapprove) escreve `status` pelo CrudService.
  statusUpdatable: true,
  softDelete: { field: 'inactiveAt' },
  hooks: {
    preWrite: async ({ op, data, deps }) => {
      if (op !== 'create') return undefined;
      if (Number(data.depth) > 2) {
        throw new CrudError('VALIDATION_FAILED', 'Profundidade máxima de comentários é 2', 'depth');
      }
      // Uma avaliação por visitante por post.
      if (data.rating) {
        const prisma = deps.prisma as PrismaService;
        const existing = await prisma.blog_Comment.findFirst({
          where: { postId: Number(data.postId), visitorId: Number(data.visitorId), rating: { not: null }, inactiveAt: null },
          select: { id: true },
        });
        if (existing) throw new CrudError('CONFLICT', 'Você já avaliou este post', 'rating');
      }
      return undefined;
    },
  },
};
export type CommentRequest = Request;
