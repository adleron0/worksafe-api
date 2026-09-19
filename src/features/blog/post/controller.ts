import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UploadedFile,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
  Query,
  applyDecorators,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
// Import entity template
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { IEntity } from './interfaces/interface';
import { PostService as Service } from './service';
// Import utils specifics
import { FileInterceptor } from '@nestjs/platform-express';
import { getOptimizedMulterOptions } from '../../upload/upload.middleware';
import { ImageOptimizationInterceptor } from '../../upload/image-optimization.interceptor';
// Import generic controller
import { GenericController } from 'src/features/generic/generic.controller';
import { Public } from 'src/auth/decorators/public.decorator';
// Import cache
import { Cache, CacheEvictAll } from 'src/common/cache';
import { CacheService } from 'src/common/cache/cache.service';
// Import AI
import { AIService } from 'src/common/ai';
// Import de configuraões
import { paramsIncludes } from './associations';
import {
  noCompany,
  validateCreate,
  formaterPreUpdate,
  omitAttributes,
  hooksCreate,
  hooksUpdate,
  encryptFields,
} from './rules';

function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: 'Blog_Post' as keyof PrismaClient,
  name: 'Post',
  route: 'blog/posts',
  permission: 'blog',
};

@Controller(entity.route)
export class PostController extends GenericController<
  CreateDto,
  UpdateDto,
  IEntity,
  Service
> {
  constructor(
    private readonly Service: Service,
    // cacheService é usado pelos decorators de cache
    private readonly cacheService: CacheService,
    // AI Service para geração de conteúdo
    private readonly aiService: AIService,
  ) {
    super(Service, entity);
  }

  @UserPermission(`list_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @Cache({ prefix: 'blog/posts', ttl: 1800 })
  @Get()
  async get(@Req() request: Request, @Query() query: any) {
    // Adiciona omitAttributes aos filtros se não estiver presente
    // Sempre do servidor: o cliente não escolhe o que omitir (senão
      // ?omitAttributes[]=id devolveria hash de senha e sellerConfig).
      query.omitAttributes = omitAttributes;
    return super.get(request, query, paramsIncludes, noCompany, encryptFields);
  }

  @UserPermission(`create_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @CacheEvictAll('blog/posts:*', 'blog-posts-public:*', 'blog-post-slug:*', 'cache:*/blog/posts*', 'cache:*/blog-posts-public*', 'cache:*/blog-post-slug*')
  @Post()
  @UseInterceptors(
    FileInterceptor('image', getOptimizedMulterOptions()),
    ImageOptimizationInterceptor,
  )
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async create(
    @Req() request: Request,
    @Body() CreateDto: CreateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    // Se há arquivo, adiciona a URL ao DTO
    if (file && file.location) {
      CreateDto.coverImage = file.location;
    }

    // Extrai tagIds antes de criar o post
    const tagIds = CreateDto.tagIds;
    delete CreateDto.tagIds;

    const search = validateCreate(request, CreateDto);
    // Não passa file para super.create pois já definimos coverImage manualmente
    const created = await super.create(request, CreateDto, null, search, hooksCreate);

    // Cria as relações de tags após criar o post
    if (tagIds && Array.isArray(tagIds) && tagIds.length > 0) {
      const tagRelations = tagIds.map((tagId: number) => ({
        postId: created.id,
        tagId: Number(tagId),
      }));

      await this.Service.createPostTags(tagRelations);
    }

    return created;
  }

  @UserPermission(`update_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @CacheEvictAll('blog/posts:*', 'blog-posts-public:*', 'blog-post-slug:*', 'cache:*/blog/posts*', 'cache:*/blog-posts-public*', 'cache:*/blog-post-slug*')
  @Put(':id')
  @UseInterceptors(
    FileInterceptor('image', getOptimizedMulterOptions()),
    ImageOptimizationInterceptor,
  )
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async update(
    @Param('id') id: number,
    @Req() request: Request,
    @Body() UpdateDto: UpdateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    // Se há arquivo, adiciona a URL ao DTO
    if (file && file.location) {
      UpdateDto.coverImage = file.location;
    }

    // Extrai tagIds antes de atualizar o post
    const tagIds = UpdateDto.tagIds;
    delete UpdateDto.tagIds;

    const processedDto = formaterPreUpdate(UpdateDto);
    // Não passa file para super.update pois já definimos coverImage manualmente
    const updated = await super.update(id, request, processedDto, null, hooksUpdate);

    // Atualiza as relações de tags se foram enviadas
    if (tagIds !== undefined) {
      await this.Service.updatePostTags(Number(id), tagIds || []);
    }

    return updated;
  }

  @UserPermission(`activate_${entity.permission}`)
  @CacheEvictAll('blog/posts:*', 'blog-posts-public:*', 'blog-post-slug:*', 'cache:*/blog/posts*', 'cache:*/blog-posts-public*', 'cache:*/blog-post-slug*')
  @Patch('publish/:id')
  async publish(@Param('id') id: number) {
    return this.Service.publish(id);
  }

  @UserPermission(`inactive_${entity.permission}`)
  @CacheEvictAll('blog/posts:*', 'blog-posts-public:*', 'blog-post-slug:*', 'cache:*/blog/posts*', 'cache:*/blog-posts-public*', 'cache:*/blog-post-slug*')
  @Patch('archive/:id')
  async archive(@Param('id') id: number) {
    return this.Service.archive(id);
  }

  @UserPermission(`update_${entity.permission}`)
  @CacheEvictAll('blog/posts:*', 'blog-posts-public:*', 'blog-post-slug:*', 'cache:*/blog/posts*', 'cache:*/blog-posts-public*', 'cache:*/blog-post-slug*')
  @Patch('draft/:id')
  async toDraft(@Param('id') id: number) {
    return this.Service.toDraft(id);
  }

  // ==================== ROTAS DE IA ====================

  /**
   * Gera um artigo completo usando IA
   * Recebe título, resumo e categoria e retorna o conteúdo do artigo
   * Aceita JSON ou FormData
   */
  @UserPermission(`create_${entity.permission}`)
  @Post('ai/generate')
  @UseInterceptors(FileInterceptor('file')) // Permite FormData
  async generateArticle(
    @Body() body: { title: string; summary: string; category: string; tone?: 'formal' | 'informal' | 'technical' },
  ) {
    if (!body || !body.title || !body.summary || !body.category) {
      throw new BadRequestException('title, summary e category são obrigatórios');
    }

    const content = await this.aiService.generateArticle({
      title: body.title,
      summary: body.summary,
      category: body.category,
      tone: body.tone || 'technical',
      language: 'português brasileiro',
      minWords: 800,
    });

    return {
      content,
      supplier: this.aiService.getActiveSupplier(),
    };
  }

  /**
   * Revisa e melhora um artigo existente usando IA
   * Retorna o texto melhorado, correções, sugestões e referências
   * Aceita JSON ou FormData
   */
  @UserPermission(`update_${entity.permission}`)
  @Post('ai/review')
  @UseInterceptors(FileInterceptor('file')) // Permite FormData
  async reviewArticle(
    @Body() body: { content: string; title?: string; category?: string; includeReferences?: boolean },
  ) {
    if (!body || !body.content) {
      throw new BadRequestException('content é obrigatório');
    }

    const result = await this.aiService.reviewAndImprove({
      content: body.content,
      title: body.title,
      category: body.category,
      includeReferences: body.includeReferences !== false,
    });

    return {
      ...result,
      supplier: this.aiService.getActiveSupplier(),
    };
  }

  // ==================== ROTAS PÚBLICAS ====================

  @Public()
  @Cache({ prefix: 'blog-posts-public', ttl: 1800 })
  @Get('public')
  async getPublic(@Query() query: any) {
    query.status = 'published';
    query.active = 'true';
    const noCompanyPublic = true; // Usa companyId da query, não do token
    return super.get(
      { user: { companyId: query.companyId } } as any,
      query,
      paramsIncludes,
      noCompanyPublic,
      encryptFields,
    );
  }

  @Public()
  @Cache({
    prefix: 'blog-post-slug',
    ttl: 300,
    key: (req) => {
      const slug = req.params.slug;
      const companyId = req.query.companyId || req.query['company.lp_domain'] || 'unknown';
      return `blog-post-slug:${companyId}:${slug}`;
    },
  })
  @Get('public/:slug')
  async getBySlug(
    @Param('slug') slug: string,
    @Query() query: any,
  ) {
    // Suporta companyId direto ou busca por company.lp_domain
    let companyId = query.companyId;

    if (!companyId && query['company.lp_domain']) {
      const company = await this.Service.findCompanyByDomain(query['company.lp_domain']);
      if (!company) {
        throw new BadRequestException('Empresa não encontrada');
      }
      companyId = company.id;
    }

    if (!companyId) {
      throw new BadRequestException('companyId ou company.lp_domain é obrigatório');
    }

    return this.Service.findBySlugAndIncrementViews(Number(companyId), slug);
  }
}
