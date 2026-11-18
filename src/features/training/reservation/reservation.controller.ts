import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { permissionsOf } from 'src/features/commercial/proposal.controller';
import { READ_PERMISSIONS, ReservationActor, ReservationService, WRITE_PERMISSIONS, requireAny } from './reservation.service';

type Json = Record<string, unknown>;
type Q = Record<string, string>;

const actorOf = (req: Request): ReservationActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number; permissions?: unknown } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0), permissions: permissionsOf(user?.permissions) };
};
const reader = (req: Request) => { const a = actorOf(req); requireAny(a, READ_PERMISSIONS); return a; };
const writer = (req: Request) => { const a = actorOf(req); requireAny(a, WRITE_PERMISSIONS); return a; };

/**
 * Vagas de turma aberta reservadas para empresas. Quem gerencia turmas
 * (update_classes) ou quem vende (update_comercial) pode reservar; aumentar o
 * limite da turma só quem gerencia turmas.
 */
@Controller('class-reservations')
export class ReservationController {
  constructor(private readonly reservations: ReservationService) {}

  @Get() list(@Req() req: Request, @Query() q: Q) { return this.reservations.list(reader(req), q ?? {}); }
  @Get('open-classes') openClasses(@Req() req: Request, @Query() q: Q) { return this.reservations.openClasses(reader(req), q ?? {}); }
  @Get('availability/:classId') availability(@Param('classId', ParseIntPipe) classId: number, @Req() req: Request) { return this.reservations.availability(reader(req), classId); }
  @Get('contract/:contractId') contract(@Param('contractId', ParseIntPipe) id: number, @Req() req: Request) { return this.reservations.contractOptions(reader(req), id); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reservations.get(reader(req), id); }
  @Get(':id/report') report(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reservations.report(reader(req), id); }

  @Post() create(@Req() req: Request, @Body() body: Json) { return this.reservations.create(writer(req), body ?? {}); }
  @Put(':id') update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.reservations.update(writer(req), id, body ?? {}); }
  @Post(':id/cancel') cancel(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.reservations.cancel(writer(req), id, body ?? {}); }
  @Post(':id/transfer') transfer(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.reservations.transfer(writer(req), id, body ?? {}); }
  @Post(':id/students') addStudents(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.reservations.addStudents(writer(req), id, body ?? {}); }
  @Put(':id/students/:subscriptionId') swap(@Param('id', ParseIntPipe) id: number, @Param('subscriptionId', ParseIntPipe) sub: number, @Req() req: Request, @Body() body: Json) {
    return this.reservations.swapStudent(writer(req), id, sub, body ?? {});
  }
  @Delete(':id/students/:subscriptionId') remove(@Param('id', ParseIntPipe) id: number, @Param('subscriptionId', ParseIntPipe) sub: number, @Req() req: Request) {
    return this.reservations.removeStudent(writer(req), id, sub);
  }
}
