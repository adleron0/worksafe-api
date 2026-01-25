import {
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
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { BlogCommentStatus, PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
// Import entity template
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { IEntity } from './interfaces/interface';
import { CommentService as Service } from './service';
// Import utils specifics
import { FileInterceptor } from '@nestjs/platform-express';

// Import generic controller
import { GenericController } from 'src/features/generic/generic.controller';
import { Public } from 'src/auth/decorators/public.decorator';
// Import visitor guard
import { VisitorAuthGuard } from '../auth/guards/visitor-auth.guard';
// Import cache
import { Cache, CacheEvictAll } from 'src/common/cache';
import { CacheService } from 'src/common/cache/cache.service';
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
  model: 'Blog_Comment' as keyof PrismaClient,
  name: 'Comment',
  route: 'blog/comments',
  permission: 'blog',
};

@Controller(entity.route)
export class CommentController extends GenericController<
  CreateDto,
  UpdateDto,
  IEntity,
  Service
> {
  constructor(
    private readonly Service: Service,
    // cacheService é usado pelos decorators de cache
    private readonly cacheService: CacheService,
  ) {
    super(Service, entity);
  }

  @UserPermission(`list_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  // @Cache({ prefix: 'blog/comments', ttl: 3600 }) // descomente para usar cache (1 hora)
  @Get()
  async get(@Req() request: Request, @Query() query: any) {
    // Adiciona omitAttributes aos filtros se não estiver presente
    if (!query.omitAttributes) {
      query.omitAttributes = omitAttributes;
    }
    return super.get(request, query, paramsIncludes, noCompany, encryptFields);
  }

  @UserPermission(`create_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  // @CacheEvictAll('blog/comments:*', 'cache:*/blog/comments*') // descomente para limpar cache
  @Post()
  @UseInterceptors(
    FileInterceptor('file'),
  )
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async create(
    @Req() request: Request,
    @Body() CreateDto: CreateDto,
    
  ) {
    
    const search = validateCreate(request, CreateDto);
    return super.create(request, CreateDto, null, search, hooksCreate);
  }

  @UserPermission(`update_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  // @CacheEvictAll('blog/comments:*', 'cache:*/blog/comments*') // descomente para limpar cache
  @Put(':id')
  @UseInterceptors(
    FileInterceptor('file'),
  )
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async update(
    @Param('id') id: number,
    @Req() request: Request,
    @Body() UpdateDto: UpdateDto,
    
  ) {
    
    const processedDto = formaterPreUpdate(UpdateDto);
    return super.update(id, request, processedDto, null, hooksUpdate);
  }

  @UserPermission(`activate_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  // @CacheEvictAll('blog/comments:*', 'cache:*/blog/comments*') // descomente para limpar cache
  @Patch('active/:id')
  async activate(@Param('id') id: number, @Req() request: Request) {
    return super.activate(id, request);
  }

  @UserPermission(`inactive_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  // @CacheEvictAll('blog/comments:*', 'cache:*/blog/comments*') // descomente para limpar cache
  @Patch('inactive/:id')
  async inactivate(@Param('id') id: number, @Req() request: Request) {
    return super.inactivate(id, request);
  }

  // ==================== ROTAS DE MODERAÇÃO ====================

  @UserPermission(`update_${entity.permission}`)
  @Patch('approve/:id')
  async approve(@Param('id') id: number) {
    return this.Service.setStatus(Number(id), BlogCommentStatus.published);
  }

  @UserPermission(`update_${entity.permission}`)
  @Patch('disapprove/:id')
  async disapprove(@Param('id') id: number) {
    return this.Service.setStatus(Number(id), BlogCommentStatus.hidden);
  }

  // ==================== ROTAS PÚBLICAS ====================

  /**
   * Lista comentários publicados de um post
   */
  @Public()
  @Get('public')
  async getPublicComments(@Query() query: any) {
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
    if (!query.postId) {
      throw new BadRequestException('postId é obrigatório');
    }

    const page = query.page ? Number(query.page) : 0;
    const limit = query.limit ? Number(query.limit) : 10;

    return this.Service.getPublicComments(
      Number(companyId),
      Number(query.postId),
      page,
      limit,
    );
  }

  /**
   * Cria comentário (requer visitante autenticado)
   */
  @Public()
  @UseGuards(VisitorAuthGuard)
  @Post('public')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async createPublicComment(@Req() req: any, @Body() body: any) {
    console.log('🔍 createPublicComment - body:', body);
    console.log('🔍 createPublicComment - visitor:', req.visitor);

    if (!body || !body.postId) {
      throw new BadRequestException('postId é obrigatório no body');
    }

    return this.Service.createPublicComment(req.visitor, body);
  }
}
