import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { BlogCommentStatus } from '@prisma/client';

@Injectable()
export class CommentService {
  constructor(protected prisma: PrismaService) {}

  /**
   * Busca empresa por domínio
   */
  async findCompanyByDomain(domain: string) {
    return this.prisma.company.findFirst({
      where: { lp_domain: domain },
      select: { id: true },
    });
  }

  /**
   * Cria comentário público (via visitante autenticado)
   */
  async createPublicComment(
    visitor: { sub: number; companyId: number },
    body: { postId: number; content: string; rating?: number; parentId?: number },
  ) {
    const { postId, content, rating, parentId } = body;

    // Verifica se o visitante está bloqueado
    const visitorData = await this.prisma.blog_Visitor.findUnique({
      where: { id: visitor.sub },
    });

    if (!visitorData || visitorData.blocked) {
      throw new BadRequestException('Visitante bloqueado');
    }

    // Verifica se o post existe e está publicado
    const post = await this.prisma.blog_Post.findFirst({
      where: {
        id: Number(postId),
        companyId: visitor.companyId,
        status: 'published',
        inactiveAt: null,
      },
    });

    if (!post) {
      throw new BadRequestException('Post não encontrado');
    }

    // Calcula a profundidade
    let depth = 0;
    if (parentId) {
      const parentComment = await this.prisma.blog_Comment.findUnique({
        where: { id: Number(parentId) },
      });

      if (!parentComment) {
        throw new BadRequestException('Comentário pai não encontrado');
      }

      depth = parentComment.depth + 1;

      if (depth > 2) {
        throw new BadRequestException('Profundidade máxima de comentários é 2');
      }
    }

    // Rate limit: 30 segundos entre comentários
    const lastComment = await this.prisma.blog_Comment.findFirst({
      where: {
        visitorId: visitor.sub,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (lastComment) {
      const timeSinceLastComment = Date.now() - lastComment.createdAt.getTime();
      const rateLimitMs = 30 * 1000; // 30 segundos

      if (timeSinceLastComment < rateLimitMs) {
        const waitSeconds = Math.ceil((rateLimitMs - timeSinceLastComment) / 1000);
        throw new BadRequestException(
          `Aguarde ${waitSeconds} segundos antes de comentar novamente`,
        );
      }
    }

    // Se tem rating, verifica se já avaliou
    if (rating) {
      const existingRating = await this.prisma.blog_Comment.findFirst({
        where: {
          postId: Number(postId),
          visitorId: visitor.sub,
          rating: { not: null },
          inactiveAt: null,
        },
      });

      if (existingRating) {
        throw new BadRequestException('Você já avaliou este post');
      }
    }

    // Cria o comentário
    const comment = await this.prisma.blog_Comment.create({
      data: {
        companyId: visitor.companyId,
        postId: Number(postId),
        visitorId: visitor.sub,
        content,
        rating: rating ? Number(rating) : null,
        parentId: parentId ? Number(parentId) : null,
        depth,
        status: BlogCommentStatus.published, // Comentários públicos são exibidos imediatamente
      },
      include: {
        visitor: {
          select: { id: true, name: true, avatarUrl: true },
        },
      },
    });

    return comment;
  }

  /**
   * Lista comentários públicos de um post (apenas raiz, com replies)
   */
  async getPublicComments(companyId: number, postId: number, page = 0, limit = 10) {
    const skip = page * limit;

    const [items, totalItems] = await Promise.all([
      this.prisma.blog_Comment.findMany({
        where: {
          companyId: Number(companyId),
          postId: Number(postId),
          status: BlogCommentStatus.published,
          inactiveAt: null,
          parentId: null, // Apenas comentários raiz
        },
        include: {
          visitor: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
          replies: {
            where: {
              status: BlogCommentStatus.published,
              inactiveAt: null,
            },
            include: {
              visitor: {
                select: { id: true, name: true, email: true, avatarUrl: true },
              },
              replies: {
                where: {
                  status: BlogCommentStatus.published,
                  inactiveAt: null,
                },
                include: {
                  visitor: {
                    select: { id: true, name: true, email: true, avatarUrl: true },
                  },
                },
                orderBy: { createdAt: 'asc' },
              },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.blog_Comment.count({
        where: {
          companyId: Number(companyId),
          postId: Number(postId),
          status: BlogCommentStatus.published,
          inactiveAt: null,
          parentId: null,
        },
      }),
    ]);

    // Transforma visitor em user para compatibilidade com frontend
    const transformComment = (comment: any) => ({
      ...comment,
      user: comment.visitor
        ? {
            id: comment.visitor.id,
            name: comment.visitor.name,
            email: comment.visitor.email,
            avatar: comment.visitor.avatarUrl,
          }
        : null,
      visitor: undefined,
      replies: comment.replies?.map(transformComment) || [],
    });

    const rows = items.map(transformComment);

    return {
      rows,
      total: totalItems,
      page,
      limit,
      totalPages: Math.ceil(totalItems / limit),
    };
  }
}
