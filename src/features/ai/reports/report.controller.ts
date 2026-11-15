import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { actorOf } from '../ai.controller';
import { ReportService } from './report.service';

type Json = Record<string, any>;

/** Relatórios agendados (configuração) e relatórios gerados (leitura). */
@Controller('ai')
export class ReportController {
  constructor(private readonly reports: ReportService) {}

  @Permissions('update_bots') @Get('schedules')
  schedules(@Req() req: Request) { return this.reports.list(actorOf(req)); }

  @Permissions('update_bots') @Post('schedules')
  create(@Req() req: Request, @Body() body: Json) { return this.reports.create(actorOf(req), body ?? {}); }

  @Permissions('update_bots') @Put('schedules/:id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.reports.update(actorOf(req), id, body ?? {}); }

  @Permissions('update_bots') @Patch('schedules/:id/remove')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reports.remove(actorOf(req), id); }

  @Permissions('update_bots') @Post('schedules/:id/run') @HttpCode(200)
  run(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reports.runNow(actorOf(req), id); }

  @Permissions('usar_bots') @Get('reports')
  list(@Req() req: Request, @Query() query: Record<string, string>) { return this.reports.reports(actorOf(req), query ?? {}); }

  @Permissions('usar_bots') @Get('reports/:id')
  get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.reports.report(actorOf(req), id); }
}
