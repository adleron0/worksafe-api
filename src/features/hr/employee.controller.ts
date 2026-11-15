import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { permissionsOf } from 'src/features/commercial/proposal.controller';
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
  constructor(private readonly employees: EmployeeService) {}

  @Permissions('list_funcionarios') @Get()
  list(@Req() req: Request, @Query() query: Record<string, string>) { return this.employees.list(actorOf(req), query ?? {}); }

  @Permissions('list_funcionarios') @Get('options')
  options(@Req() req: Request) { return this.employees.options(actorOf(req)); }

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
