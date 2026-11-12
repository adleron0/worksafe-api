import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class PostService {
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
   * Busca post por slug e incrementa visualizações
   */
  async findBySlugAndIncrementViews(companyId: number, slug: string) {
    const post = await this.prisma.blog_Post.findFirst({
      where: {
        companyId: Number(companyId),
        slug,
        status: 'published',
        inactiveAt: null,
      },
      include: {
        author: { select: { id: true, name: true, imageUrl: true } },
        category: { select: { id: true, name: true, slug: true } },
        tags: { include: { tag: true } },
        _count: { select: { comments: true } },
      },
    });

    if (!post) {
      throw new BadRequestException('Post não encontrado');
    }

    // Incrementa viewCount em background (não bloqueia resposta).
    // SQL direto de propósito: `@updatedAt` é aplicado pelo Prisma Client em
    // todo update, e uma visita não é edição — o site usa updatedAt como
    // "Atualizado em" / dateModified / lastmod do sitemap.
    this.incrementViews(post.id).catch(() => {});

    return post;
  }

  /** +1 visualização sem tocar em `updatedAt`. */
  incrementViews(postId: number) {
    return this.prisma.$executeRaw`UPDATE "Blog_Post" SET "viewCount" = "viewCount" + 1 WHERE "id" = ${postId}`;
  }
}
