import { CrudService } from '@adleron/crud-core';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';

import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { Public } from 'src/auth/decorators/public.decorator';
import { AIService } from 'src/common/ai';
import { Cache, CacheEvictAll } from 'src/common/cache';
import { defineWorksafeEntity } from 'src/common/crud/crud.module';
import { blogPostEntity } from './rules.crud';
import { PostService } from './service';

const def = defineWorksafeEntity(blogPostEntity);
const evict = CacheEvictAll(
  'blog/posts:*', 'blog-posts-public:*', 'blog-post-slug:*',
  'cache:*/blog/posts*', 'cache:*/blog-posts-public*', 'cache:*/blog-post-slug*',
);

/**
 * Rotas do post fora do CRUD: fluxo de status, IA e slug público. Status
 * passa pelo CrudService (escopo + auditoria) — o service antigo fazia
 * update por id sem companyId.
 */
@Controller('blog/posts')
export class PostCustomController {
  constructor(
    private readonly crud: CrudService<Request>,
    private readonly posts: PostService,
    private readonly ai: AIService,
  ) {}

  @Permissions('activate_blog') @evict @Patch('publish/:id')
  async publish(@Param('id') id: string, @Req() request: Request) {
    await this.reviveIfArchived(id, request);
    return this.crud.update(def, id, { status: 'published', publishedAt: new Date() }, request);
  }

  @Permissions('inactive_blog') @evict @Patch('archive/:id')
  archive(@Param('id') id: string, @Req() request: Request) {
    return this.crud.archive(def, id, request); // hook põe status='archived'
  }

  @Permissions('update_blog') @evict @Patch('draft/:id')
  async toDraft(@Param('id') id: string, @Req() request: Request) {
    await this.reviveIfArchived(id, request);
    return this.crud.update(def, id, { status: 'draft' }, request);
  }

  private async reviveIfArchived(id: string, request: Request) {
    const current = await this.crud.getById(def, id, request);
    if (current.inactiveAt) await this.crud.restore(def, id, request);
  }

  @Permissions('create_blog') @Post('ai/generate') @UseInterceptors(FileInterceptor('file'))
  async generateArticle(@Body() body: { title: string; summary: string; category: string; tone?: 'formal' | 'informal' | 'technical' }) {
    if (!body?.title || !body.summary || !body.category) {
      throw new BadRequestException('title, summary e category são obrigatórios');
    }
    const content = await this.ai.generateArticle({
      title: body.title, summary: body.summary, category: body.category,
      tone: body.tone || 'technical', language: 'português brasileiro', minWords: 800,
    });
    return { content, supplier: this.ai.getActiveSupplier() };
  }

  @Permissions('update_blog') @Post('ai/review') @UseInterceptors(FileInterceptor('file'))
  async reviewArticle(@Body() body: { content: string; title?: string; category?: string; includeReferences?: boolean }) {
    if (!body?.content) throw new BadRequestException('content é obrigatório');
    const result = await this.ai.reviewAndImprove({
      content: body.content, title: body.title, category: body.category,
      includeReferences: body.includeReferences !== false,
    });
    return { ...result, supplier: this.ai.getActiveSupplier() };
  }

  @Public()
  @Cache({
    prefix: 'blog-post-slug', ttl: 300,
    key: (req) => `blog-post-slug:${req.query.companyId || req.query['company.lp_domain'] || 'unknown'}:${req.params.slug}`,
  })
  @Get('public/:slug')
  async getBySlug(@Param('slug') slug: string, @Query() query: Record<string, string>) {
    return this.posts.findBySlug(await this.resolveCompanyId(query), slug);
  }

  /**
   * Conta uma leitura real do post. O site chama isto a partir do navegador do
   * visitante (via server function), repassando user-agent e IP de quem leu.
   */
  @Public()
  @Post('public/:slug/view')
  async registerView(
    @Param('slug') slug: string,
    @Query() query: Record<string, string>,
    @Body() body: { userAgent?: string; ip?: string },
  ) {
    return this.posts.registerView(await this.resolveCompanyId(query), slug, {
      userAgent: body?.userAgent,
      ip: body?.ip,
    });
  }

  private async resolveCompanyId(query: Record<string, string>): Promise<number> {
    let companyId = query.companyId;
    if (!companyId && query['company.lp_domain']) {
      const company = await this.posts.findCompanyByDomain(query['company.lp_domain']);
      if (!company) throw new BadRequestException('Empresa não encontrada');
      companyId = String(company.id);
    }
    if (!companyId) throw new BadRequestException('companyId ou company.lp_domain é obrigatório');
    return Number(companyId);
  }
}
