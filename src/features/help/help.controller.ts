import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { permissionsOf } from 'src/features/commercial/proposal.controller';
import { HelpActor } from './help.rules';
import { HelpService } from './help.service';

function actorOf(req: Request): HelpActor {
  const user = (
    req as Request & {
      user?: { sub?: number; companyId?: number; permissions?: unknown };
    }
  ).user;
  return {
    userId: Number(user?.sub ?? 0),
    companyId: Number(user?.companyId ?? 0),
    permissions: permissionsOf(user?.permissions),
  };
}

/** Central de ajuda. Serve a qualquer pessoa logada: cada um só lê e grava o próprio estado. */
@Controller('help')
export class HelpController {
  constructor(private readonly help: HelpService) {}

  @Get('state')
  state(@Req() req: Request) {
    return this.help.state(actorOf(req));
  }

  @Put('state/:tourId')
  setState(
    @Param('tourId') tourId: string,
    @Body() body: { action?: unknown },
    @Req() req: Request,
  ) {
    return this.help.setState(actorOf(req), tourId, body?.action);
  }

  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Post('events')
  @HttpCode(200)
  record(@Body() body: { events?: unknown }, @Req() req: Request) {
    return this.help.record(actorOf(req), body);
  }
}
