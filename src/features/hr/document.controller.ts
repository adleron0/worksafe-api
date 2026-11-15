import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import * as multer from 'multer';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { DOCUMENT_MAX_BYTES, DocumentActor, EmployeeDocumentService, UploadedDocument } from './document.service';

const actorOf = (req: Request): DocumentActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0) };
};
type Json = Record<string, unknown>;
/** O arquivo passa pela memória da API até o armazenamento privado: nunca vai para o bucket público. */
const UPLOAD = { storage: multer.memoryStorage(), limits: { fileSize: DOCUMENT_MAX_BYTES } };

/** Documentos dos funcionários (RH): tipos, pastas, vencimentos e o arquivo. */
@Controller('hr-documents')
export class EmployeeDocumentController {
  constructor(private readonly documents: EmployeeDocumentService) {}

  @Permissions('view_documentos_funcionarios') @Get('types')
  types(@Req() req: Request, @Query() query: Record<string, string>) { return this.documents.types(actorOf(req), query ?? {}); }

  @Permissions('update_documentos_funcionarios') @Post('types')
  createType(@Req() req: Request, @Body() body: Json) { return this.documents.createType(actorOf(req), body ?? {}); }

  @Permissions('update_documentos_funcionarios') @Put('types/:id')
  updateType(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.documents.updateType(actorOf(req), id, body ?? {}); }

  @Permissions('update_documentos_funcionarios') @Patch('types/:id/inactive')
  inactivateType(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.documents.setTypeActive(actorOf(req), id, false); }

  @Permissions('update_documentos_funcionarios') @Patch('types/:id/active')
  activateType(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.documents.setTypeActive(actorOf(req), id, true); }

  @Permissions('view_documentos_funcionarios') @Get('expiring')
  expiring(@Req() req: Request, @Query() query: Record<string, string>) { return this.documents.expiring(actorOf(req), query ?? {}); }

  @Permissions('view_documentos_funcionarios') @Get('employee/:employeeId')
  ofEmployee(@Param('employeeId', ParseIntPipe) employeeId: number, @Req() req: Request) { return this.documents.ofEmployee(actorOf(req), employeeId); }

  @Permissions('update_documentos_funcionarios') @Post('employee/:employeeId')
  @UseInterceptors(FileInterceptor('file', UPLOAD))
  upload(@Param('employeeId', ParseIntPipe) employeeId: number, @Req() req: Request, @Body() body: Json, @UploadedFile() file?: UploadedDocument) {
    return this.documents.upload(actorOf(req), employeeId, file, body ?? {});
  }

  @Permissions('update_documentos_funcionarios') @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.documents.update(actorOf(req), id, body ?? {}); }

  @Permissions('update_documentos_funcionarios') @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.documents.remove(actorOf(req), id); }

  /** O arquivo só sai por aqui: sem link direto, sem cache, e cada acesso fica registrado. */
  @Permissions('view_documentos_funcionarios') @Get(':id/file')
  async file(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Res() res: Response, @Query('download') download?: string) {
    const { body, fileName, mimeType } = await this.documents.file(actorOf(req), id);
    res.set({
      'Content-Type': mimeType, 'Content-Length': String(body.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    });
    res.end(body);
  }
}
