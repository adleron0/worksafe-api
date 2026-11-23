import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import * as multer from 'multer';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { Public } from 'src/auth/decorators/public.decorator';
import { actorOf } from '../ai.controller';
import { InstagramService } from './instagram.service';

type Json = Record<string, unknown>;

/** Bots → Conectores: contas externas da empresa (hoje, o Instagram) e os posts agendados. */
@Controller('ai')
export class ConnectorsController {
  constructor(private readonly instagram: InstagramService) {}

  private seeing(req: Request) {
    const actor = actorOf(req);
    if (!actor.permissions.includes('conectores_bots') && !actor.permissions.includes('instagram_bots')) throw new ForbiddenException('Acesso negado: Permissões insuficientes');
    return actor;
  }

  @Get('connectors')
  async list(@Req() req: Request) {
    const actor = this.seeing(req);
    return { instagram: await this.instagram.status(actor.companyId) };
  }

  @Permissions('conectores_bots') @Post('connectors/instagram/start') @HttpCode(200)
  start(@Req() req: Request) { return this.instagram.startUrl(actorOf(req)); }

  /** Volta da tela de permissão da Meta (sem login: quem a pessoa é vem no state assinado). */
  @Public() @Get('connectors/instagram/callback')
  async callback(@Query() query: Json, @Res() res: Response) {
    res.redirect(302, await this.instagram.callback(query));
  }

  @Permissions('conectores_bots') @Delete('connectors/instagram')
  disconnect(@Req() req: Request) { return this.instagram.disconnect(actorOf(req).companyId); }

  // ---------------------------------------------------------------- posts

  @Permissions('instagram_bots') @Get('instagram/posts')
  posts(@Req() req: Request, @Query('status') status?: string) { return this.instagram.list(actorOf(req).companyId, { status }); }

  @Permissions('instagram_bots') @Post('instagram/posts')
  create(@Req() req: Request, @Body() body: Json) { return this.instagram.create(actorOf(req), body ?? {}); }

  @Permissions('instagram_bots') @Post('instagram/upload')
  @UseInterceptors(FileInterceptor('file', { storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }))
  upload(@UploadedFile() file?: { buffer: Buffer }) { return this.instagram.upload(file?.buffer as Buffer); }

  @Permissions('instagram_bots') @Post('instagram/posts/:id/publish') @HttpCode(200)
  publish(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.instagram.publishNow(actorOf(req).companyId, id); }

  @Permissions('instagram_bots') @Patch('instagram/posts/:id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.instagram.cancel(actorOf(req).companyId, id); }
}
