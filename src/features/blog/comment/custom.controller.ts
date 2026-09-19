import { CrudService } from '@adleron/crud-core';
import {
  BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { BlogCommentStatus } from '@prisma/client';
import { Request } from 'express';

import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { Public } from 'src/auth/decorators/public.decorator';
import { defineWorksafeEntity } from 'src/common/crud/crud.module';
import { VisitorAuthGuard } from '../auth/guards/visitor-auth.guard';
import { blogCommentEntity } from './rules.crud';
import { CommentService } from './service';

const def = defineWorksafeEntity(blogCommentEntity);

/** Moderação (via CrudService: escopo + auditoria) e rotas públicas do blog. */
@Controller('blog/comments')
export class CommentCustomController {
  constructor(private readonly crud: CrudService<Request>, private readonly comments: CommentService) {}

  @Permissions('update_blog') @Patch('approve/:id')
  approve(@Param('id') id: string, @Req() request: Request) {
    return this.crud.update(def, id, { status: BlogCommentStatus.published }, request);
  }

  @Permissions('update_blog') @Patch('disapprove/:id')
  disapprove(@Param('id') id: string, @Req() request: Request) {
    return this.crud.update(def, id, { status: BlogCommentStatus.hidden }, request);
  }

  /** Comentários publicados de um post (site). */
  @Public() @Get('public')
  async getPublicComments(@Query() query: Record<string, string>) {
    let companyId = query.companyId;
    if (!companyId && query['company.lp_domain']) {
      const company = await this.comments.findCompanyByDomain(query['company.lp_domain']);
      if (!company) throw new BadRequestException('Empresa não encontrada');
      companyId = String(company.id);
    }
    if (!companyId) throw new BadRequestException('companyId ou company.lp_domain é obrigatório');
    if (!query.postId) throw new BadRequestException('postId é obrigatório');
    return this.comments.getPublicComments(
      Number(companyId), Number(query.postId),
      query.page ? Number(query.page) : 0, query.limit ? Number(query.limit) : 10,
    );
  }

  /** Cria comentário — visitante autenticado pelo Google (VisitorAuthGuard). */
  @Public() @UseGuards(VisitorAuthGuard) @Post('public')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  createPublicComment(@Req() req: Request & { visitor: unknown }, @Body() body: { postId?: number }) {
    if (!body?.postId) throw new BadRequestException('postId é obrigatório no body');
    return this.comments.createPublicComment(req.visitor as never, body as never);
  }
}
