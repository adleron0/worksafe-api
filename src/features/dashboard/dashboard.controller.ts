import { Controller, ForbiddenException, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { permissionsOf } from 'src/features/commercial/proposal.controller';
import { DashboardService, TRAINING_PERMISSIONS } from './dashboard.service';
import { DashboardActor } from './shared';

function actorOf(req: Request): DashboardActor {
  const user = (req as Request & { user?: { sub?: number; companyId?: number; permissions?: unknown } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0), permissions: permissionsOf(user?.permissions) };
}

/**
 * Resumo da tela inicial. A rota não pede permissão de área porque serve a
 * todos os perfis; cada seção só é montada para quem tem a permissão dela.
 * Sem cache: o conteúdo muda por pessoa (permissões e "só as minhas").
 */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  summary(@Req() req: Request) {
    return this.dashboard.summary(actorOf(req));
  }

  /** Painel de treinamentos: só para quem vê turmas. */
  @Get('training')
  training(@Req() req: Request) {
    const actor = actorOf(req);
    if (!TRAINING_PERMISSIONS.some((p) => actor.permissions.includes(p))) throw new ForbiddenException('Sem acesso aos treinamentos');
    return this.dashboard.training(actor);
  }
}
