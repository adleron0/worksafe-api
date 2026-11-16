import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { permissionsOf } from 'src/features/commercial/proposal.controller';
import { DashboardService } from './dashboard.service';

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
    const user = (req as Request & { user?: { sub?: number; companyId?: number; permissions?: unknown } }).user;
    return this.dashboard.summary({ userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0), permissions: permissionsOf(user?.permissions) });
  }
}
