import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Permissions } from '../decorators/permissions.decorator';
import { AccessAdminService, Requester } from './access-admin.service';

const actor = (req: any): Requester => ({
  sub: Number(req.user?.sub),
  companyId: Number(req.user?.companyId),
  profile: req.user?.profile,
  permissions: req.user?.permissions,
});

/** Pedidos de perfil de quem entrou com o Google do domínio. */
@Controller('access-requests')
export class AccessRequestsAdminController {
  constructor(private readonly access: AccessAdminService) {}

  @Get()
  @Permissions('aprovar_acesso_user')
  list(@Req() req: any, @Query('status') status?: string) {
    return this.access.listRequests(actor(req).companyId, status);
  }

  @Get('count')
  @Permissions('aprovar_acesso_user')
  count(@Req() req: any) {
    return this.access.countPending(actor(req).companyId);
  }

  @Post(':id/approve')
  @Permissions('aprovar_acesso_user')
  approve(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: { profileId?: number }) {
    return this.access.approve(actor(req), id, Number(body?.profileId));
  }

  @Post(':id/reject')
  @Permissions('aprovar_acesso_user')
  reject(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: { reason?: string }) {
    return this.access.reject(actor(req), id, body?.reason);
  }
}

/** Convidados de fora do domínio (Gmail ou outra empresa), com prazo. */
@Controller('external-invites')
export class ExternalInvitesController {
  constructor(private readonly access: AccessAdminService) {}

  @Get()
  @Permissions('convidar_externo_user')
  list(@Req() req: any) {
    return this.access.listInvites(actor(req).companyId);
  }

  @Post()
  @Permissions('convidar_externo_user')
  create(@Req() req: any, @Body() body: any) {
    return this.access.createInvite(actor(req), body ?? {});
  }

  @Post(':id/renew')
  @Permissions('convidar_externo_user')
  renew(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: { days?: number }) {
    return this.access.renewInvite(actor(req), id, body?.days);
  }

  @Post(':id/revoke')
  @Permissions('convidar_externo_user')
  revoke(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.access.revokeInvite(actor(req), id);
  }
}

/** Domínio do Google e liga/desliga do login com Google (quem altera a empresa). */
@Controller('access-settings')
export class AccessSettingsController {
  constructor(private readonly access: AccessAdminService) {}

  @Get()
  @Permissions('update_company')
  get(@Req() req: any) {
    return this.access.getSettings(actor(req).companyId);
  }

  @Put()
  @Permissions('update_company')
  update(@Req() req: any, @Body() body: any) {
    return this.access.updateSettings(actor(req), body ?? {});
  }
}
