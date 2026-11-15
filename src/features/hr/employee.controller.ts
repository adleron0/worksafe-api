import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { permissionsOf } from 'src/features/commercial/proposal.controller';
import { DOCUMENTS_VIEW_PERMISSION, EmployeeDocumentService } from './document.service';
import { EmployeeActor, EmployeeService, OCCURRENCES_VIEW_PERMISSION, OCCURRENCES_WRITE_PERMISSION, PERSONAL_PERMISSION } from './employee.service';

const actorOf = (req: Request): EmployeeActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number; permissions?: unknown } }).user;
  const permissions = permissionsOf(user?.permissions);
  return {
    userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0),
    seesPersonal: permissions.includes(PERSONAL_PERMISSION),
    seesOccurrences: permissions.includes(OCCURRENCES_VIEW_PERMISSION) || permissions.includes(OCCURRENCES_WRITE_PERMISSION),
    writesOccurrences: permissions.includes(OCCURRENCES_WRITE_PERMISSION),
  };
};
type Json = Record<string, unknown>;

/** Funcionários (RH): cadastro, funções e histórico. */
@Controller('employees')
export class EmployeeController {
  constructor(private readonly employees: EmployeeService, private readonly documents: EmployeeDocumentService) {}

  @Permissions('list_funcionarios') @Get()
  async list(@Req() req: Request, @Query() query: Record<string, string>) {
    const actor = actorOf(req);
    const result = await this.employees.list(actor, query ?? {});
    // o sinal de documentos (em dia, a vencer, vencido, faltando) só vai para quem pode ver documentos
    const user = (req as Request & { user?: { permissions?: unknown } }).user;
    if (!permissionsOf(user?.permissions).includes(DOCUMENTS_VIEW_PERMISSION)) return { ...result, rows: result.rows.map((row) => ({ ...row, documents: null })) };
    const signals = await this.documents.signals(actor.companyId, result.rows.map((row) => row.id));
    return { ...result, rows: result.rows.map((row) => ({ ...row, documents: signals.get(row.id) ?? null })) };
  }

  @Permissions('list_funcionarios') @Get('options')
  options(@Req() req: Request) { return this.employees.options(actorOf(req)); }

  /** Mapa de alocação: quem está em qual obra, quem está livre e quem está indisponível numa janela de datas. */
  @Permissions('view_alocacao') @Get('allocation')
  allocation(@Req() req: Request, @Query() query: Record<string, string>) { return this.employees.allocation(actorOf(req), query ?? {}); }

  /** A alocação de uma pessoa só (a aba Alocação da ficha). */
  @Permissions('view_funcionarios') @Get(':id/allocation')
  allocationOf(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Query() query: Record<string, string>) { return this.employees.allocation(actorOf(req), query ?? {}, id); }

  @Permissions('view_funcionarios') @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.employees.get(actorOf(req), id); }

  @Permissions('create_funcionarios') @Post()
  create(@Req() req: Request, @Body() body: Json) { return this.employees.create(actorOf(req), body ?? {}); }

  @Permissions('update_funcionarios') @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.employees.update(actorOf(req), id, body ?? {}); }

  @Permissions('inactive_funcionarios') @Patch(':id/inactive')
  inactivate(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.employees.setActive(actorOf(req), id, false); }

  @Permissions('activate_funcionarios') @Patch(':id/active')
  activate(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.employees.setActive(actorOf(req), id, true); }

  /** Histórico: a rota pede ver o funcionário; lançar pede a permissão de ocorrências, conferida no serviço. */
  @Permissions('view_funcionarios') @Post(':id/events')
  addEvent(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.employees.addEvent(actorOf(req), id, body ?? {}); }

  @Permissions('view_funcionarios') @Patch(':id/events/:eventId')
  endEvent(@Param('id', ParseIntPipe) id: number, @Param('eventId', ParseIntPipe) eventId: number, @Req() req: Request, @Body() body: Json) {
    return this.employees.endEvent(actorOf(req), id, eventId, body ?? {});
  }

  @Permissions('view_funcionarios') @Delete(':id/events/:eventId')
  removeEvent(@Param('id', ParseIntPipe) id: number, @Param('eventId', ParseIntPipe) eventId: number, @Req() req: Request) {
    return this.employees.removeEvent(actorOf(req), id, eventId);
  }
}
