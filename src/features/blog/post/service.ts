import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { CacheService } from 'src/common/cache/cache.service';
import { PrismaService } from 'src/prisma/prisma.service';

/** Robôs, rastreadores, prévias de link e clientes HTTP: não contam como leitura. */
const BOT_UA =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|embedly|quora|pinterest|vkshare|w3c_validator|lighthouse|pagespeed|gtmetrix|headless|phantom|puppeteer|playwright|selenium|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|undici|postman|insomnia|httpie|scrapy|monitor|uptime|pingdom|statuscake|datadog|newrelic|semrush|ahrefs|mj12|dotbot|bytespider|gptbot|claude|anthropic|perplexity|ccbot|amazonbot|applebot|bingpreview|yandex|baidu|duckduck/i;

/** Mesma pessoa relendo o mesmo post dentro desta janela conta uma vez só. */
const VIEW_WINDOW_SECONDS = 6 * 60 * 60;

export function isBotUserAgent(userAgent?: string | null): boolean {
  if (!userAgent || userAgent.length < 20) return true; // sem UA de navegador
  if (!/mozilla\//i.test(userAgent)) return true;
  return BOT_UA.test(userAgent);
}

@Injectable()
export class PostService {
  constructor(
    protected prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

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
   * Busca post público por slug. NÃO conta visualização: esta rota é chamada
   * pelo servidor do site (SSR) para qualquer requisição, inclusive de robôs,
   * e fica em cache. A contagem é feita por `registerView`.
   */
  async findBySlug(companyId: number, slug: string) {
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

    return post;
  }

  /**
   * Conta uma leitura real: chamada pelo navegador do visitante (o site só
   * dispara depois que a página monta). Ignora robôs pelo user-agent e conta
   * o mesmo visitante (ip + user-agent) uma vez por post a cada 6 horas.
   */
  async registerView(
    companyId: number,
    slug: string,
    visitor: { userAgent?: string | null; ip?: string | null },
  ): Promise<{ counted: boolean; reason?: 'bot' | 'repeat' }> {
    const post = await this.prisma.blog_Post.findFirst({
      where: { companyId: Number(companyId), slug, status: 'published', inactiveAt: null },
      select: { id: true },
    });
    if (!post) throw new BadRequestException('Post não encontrado');

    if (isBotUserAgent(visitor.userAgent)) return { counted: false, reason: 'bot' };

    const fingerprint = createHash('sha256')
      .update(`${visitor.ip || 'sem-ip'}|${visitor.userAgent}`)
      .digest('hex')
      .slice(0, 32);
    let hits = 1;
    try {
      hits = await this.cache.increment(`blog-view:${post.id}:${fingerprint}`, VIEW_WINDOW_SECONDS);
    } catch {
      // Redis fora do ar: conta mesmo assim (melhor que perder a leitura)
    }
    if (hits > 1) return { counted: false, reason: 'repeat' };

    await this.incrementViews(post.id);
    return { counted: true };
  }

  /**
   * +1 visualização sem tocar em `updatedAt`. SQL direto de propósito:
   * `@updatedAt` é aplicado pelo Prisma Client em todo update, e uma visita
   * não é edição — o site usa updatedAt como "Atualizado em" / dateModified /
   * lastmod do sitemap.
   */
  incrementViews(postId: number) {
    return this.prisma.$executeRaw`UPDATE "Blog_Post" SET "viewCount" = "viewCount" + 1 WHERE "id" = ${postId}`;
  }
}
