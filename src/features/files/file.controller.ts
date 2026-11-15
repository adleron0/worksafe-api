import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req, Res, UploadedFile as Uploaded, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import * as multer from 'multer';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { permissionsOf } from 'src/features/commercial/proposal.controller';
import { FILE_MAX_BYTES } from './file.rules';
import { CompanyFileService, FILES_MANAGE_PERMISSION, FILES_WRITE_PERMISSION, FileActor, UploadedFile } from './file.service';

const actorOf = (req: Request): FileActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number; permissions?: unknown } }).user;
  const permissions = permissionsOf(user?.permissions);
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0), canWrite: permissions.includes(FILES_WRITE_PERMISSION), canManage: permissions.includes(FILES_MANAGE_PERMISSION) };
};
type Json = Record<string, unknown>;
/** O arquivo passa pela memória da API até o armazenamento privado: nunca vai para o bucket público. */
const UPLOAD = { storage: multer.memoryStorage(), limits: { fileSize: FILE_MAX_BYTES } };

/**
 * Arquivos da empresa: pastas, arquivos e lixeira. Entrar pede `view_arquivos`;
 * o que cada um pode ver (acesso por pasta) e mudar é conferido no serviço.
 */
@Controller('company-files')
export class CompanyFileController {
  constructor(private readonly files: CompanyFileService) {}

  @Permissions('view_arquivos') @Get('browse')
  browse(@Req() req: Request, @Query('folderId') folderId?: string) { return this.files.browse(actorOf(req), Number(folderId) > 0 ? Number(folderId) : null); }

  @Permissions('view_arquivos') @Get('folders')
  folders(@Req() req: Request) { return this.files.folders(actorOf(req)); }

  @Permissions('view_arquivos') @Get('search')
  search(@Req() req: Request, @Query() query: Record<string, string>) { return this.files.search(actorOf(req), query ?? {}); }

  @Permissions('manage_arquivos') @Get('profiles')
  profiles(@Req() req: Request) { return this.files.profiles(actorOf(req)); }

  @Permissions('view_arquivos') @Get('expiring')
  expiring(@Req() req: Request, @Query() query: Record<string, string>) { return this.files.expiring(actorOf(req), query ?? {}); }

  @Permissions('view_arquivos') @Get('types')
  types(@Req() req: Request, @Query() query: Record<string, string>) { return this.files.types(actorOf(req), query ?? {}); }

  @Permissions('manage_arquivos') @Post('types')
  createType(@Req() req: Request, @Body() body: Json) { return this.files.createType(actorOf(req), body ?? {}); }

  @Permissions('manage_arquivos') @Put('types/:id')
  updateType(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.files.updateType(actorOf(req), id, body ?? {}); }

  @Permissions('manage_arquivos') @Patch('types/:id/inactive')
  inactivateType(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.files.setTypeActive(actorOf(req), id, false); }

  @Permissions('manage_arquivos') @Patch('types/:id/active')
  activateType(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.files.setTypeActive(actorOf(req), id, true); }

  @Permissions('update_arquivos') @Get('trash')
  trash(@Req() req: Request) { return this.files.trash(actorOf(req)); }

  @Permissions('update_arquivos') @Post('folders')
  createFolder(@Req() req: Request, @Body() body: Json) { return this.files.createFolder(actorOf(req), body ?? {}); }

  /** Enviar uma pasta inteira: garante as pastas de dentro (usa as que existem, cria as que faltam). */
  @Permissions('update_arquivos') @Post('folders/path')
  ensurePath(@Req() req: Request, @Body() body: Json) { return this.files.ensurePath(actorOf(req), body ?? {}); }

  /** A pasta inteira num ZIP (com limite de tamanho: é montado na memória). */
  @Permissions('view_arquivos') @Get('folders/:id/zip')
  async zip(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Res() res: Response) {
    const { body, fileName } = await this.files.zip(actorOf(req), id);
    res.set({ 'Content-Type': 'application/zip', 'Content-Length': String(body.length), 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}` });
    res.end(body);
  }

  @Permissions('update_arquivos') @Put('folders/:id')
  updateFolder(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.files.updateFolder(actorOf(req), id, body ?? {}); }

  @Permissions('update_arquivos') @Delete('folders/:id')
  trashFolder(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.files.trashFolder(actorOf(req), id); }

  @Permissions('update_arquivos') @Post('folders/:id/restore')
  restoreFolder(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.files.restoreFolder(actorOf(req), id); }

  @Permissions('manage_arquivos') @Delete('folders/:id/purge')
  purgeFolder(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.files.purgeFolder(actorOf(req), id); }

  // Arquivo grande: o conteúdo vai direto do navegador ao armazenamento, em partes; a API abre, assina e fecha o envio.
  @Permissions('update_arquivos') @Post('uploads')
  startUpload(@Req() req: Request, @Body() body: Json) { return this.files.startUpload(actorOf(req), body ?? {}); }

  @Permissions('update_arquivos') @Post('uploads/:id/parts')
  uploadParts(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.files.uploadParts(actorOf(req), id, body ?? {}); }

  @Permissions('update_arquivos') @Post('uploads/:id/complete')
  finishUpload(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.files.finishUpload(actorOf(req), id, body ?? {}); }

  @Permissions('update_arquivos') @Delete('uploads/:id')
  cancelUpload(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.files.cancelUpload(actorOf(req), id); }

  @Permissions('update_arquivos') @Post('files')
  @UseInterceptors(FileInterceptor('file', UPLOAD))
  upload(@Req() req: Request, @Body() body: Json, @Uploaded() file?: UploadedFile) { return this.files.upload(actorOf(req), file, body ?? {}); }

  /** Substituir por uma versão nova: a anterior fica guardada. */
  @Permissions('update_arquivos') @Post('files/:id/replace')
  @UseInterceptors(FileInterceptor('file', UPLOAD))
  replace(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json, @Uploaded() file?: UploadedFile) { return this.files.replace(actorOf(req), id, file, body ?? {}); }

  @Permissions('manage_arquivos') @Delete('files/:id/version')
  purgeVersion(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.files.purgeVersion(actorOf(req), id); }

  @Permissions('update_arquivos') @Put('files/:id')
  updateFile(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.files.updateFile(actorOf(req), id, body ?? {}); }

  @Permissions('update_arquivos') @Delete('files/:id')
  trashFile(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.files.trashFile(actorOf(req), id); }

  @Permissions('update_arquivos') @Post('files/:id/restore')
  restoreFile(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.files.restoreFile(actorOf(req), id); }

  @Permissions('manage_arquivos') @Delete('files/:id/purge')
  purgeFile(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.files.purgeFile(actorOf(req), id); }

  @Permissions('manage_arquivos') @Get('files/:id/history')
  history(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.files.history(actorOf(req), id); }

  /** Link temporário (5 minutos) para ver ou baixar direto do armazenamento: para arquivos grandes. */
  @Permissions('view_arquivos') @Get('files/:id/link')
  link(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Query('download') download?: string) { return this.files.link(actorOf(req), id, download === '1'); }

  /** Pela API: sem link direto, sem cache, e cada acesso fica registrado. */
  @Permissions('view_arquivos') @Get('files/:id/file')
  async file(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Res() res: Response, @Query('download') download?: string) {
    const { body, fileName, mimeType, inline } = await this.files.file(actorOf(req), id, download === '1');
    res.set({
      'Content-Type': mimeType, 'Content-Length': String(body.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    });
    res.end(body);
  }
}
