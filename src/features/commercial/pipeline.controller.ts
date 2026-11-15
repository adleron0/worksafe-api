import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { PipelineService } from './pipeline.service';
import { permissionsOf } from './proposal.controller';

/**
 * "Minha esteira": a rota não pede uma permissão de área porque serve a todos
 * os perfis; cada bloco só é montado para quem tem a permissão daquela área.
 */
@Controller('my-pipeline')
export class PipelineController {
  constructor(private readonly pipeline: PipelineService) {}

  @Get()
  mine(@Req() req: Request) {
    const user = (req as Request & { user?: { sub?: number; companyId?: number; permissions?: unknown } }).user;
    return this.pipeline.mine({ userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0), permissions: permissionsOf(user?.permissions) });
  }
}
