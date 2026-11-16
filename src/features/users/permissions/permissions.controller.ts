import { Body, Controller, Get, Patch, Put, Param, ParseIntPipe, Req } from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { Request } from 'express';

@Controller('permissions')
export class PermissionsController {
  constructor(private readonly service: PermissionsService) {}

  @Get('list')
  @Permissions('list_profile')
  async getAllPermissions(@Req() request: Request) {
    const companyId = request.companyId;
    const allPermissions = await this.service.getAllPermissions(companyId);
    return allPermissions;
  }

  @Get('profile/:profileId')
  @Permissions('list_profile')
  async readProfile(@Param('profileId', ParseIntPipe) profileId: number, @Req() request: Request) {
    await this.service.assertProfileInCompany(profileId, Number(request.user.companyId));
    return this.service.getAssigned({ profileId });
  }

  @Get('user/:userId')
  @Permissions('list_profile')
  async readUser(@Param('userId', ParseIntPipe) userId: number, @Req() request: Request) {
    await this.service.assertUserInCompany(userId, Number(request.user.companyId));
    return this.service.getAssigned({ userId });
  }

  /** Tela de permissões: grava as concessões e remoções de uma vez. */
  @Put('profile/:profileId')
  @Permissions('update_profile')
  async saveProfile(
    @Param('profileId', ParseIntPipe) profileId: number,
    @Body() body: { grant?: number[]; revoke?: number[] },
    @Req() request: Request,
  ) {
    await this.service.assertProfileInCompany(profileId, Number(request.user.companyId));
    return this.service.saveBulk({ profileId }, body ?? {}, request.user);
  }

  @Put('user/:userId')
  @Permissions('update_profile')
  async saveUser(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() body: { grant?: number[]; revoke?: number[] },
    @Req() request: Request,
  ) {
    await this.service.assertUserInCompany(userId, Number(request.user.companyId));
    return this.service.saveBulk({ userId }, body ?? {}, request.user);
  }

  @Patch('user/active/:userId/:permissionId')
  @Permissions('activate_profile')
  async activeUserPermission(
    @Param('userId') userId: string,
    @Param('permissionId') permissionId: string,
    @Req() request: Request,
  ) {
    const { sub: Id, companyId } = request.user;
    const logParams = {
      userId: Id,
      companyId,
    };
    const payload = {
      userId: Number(userId),
      permissionId: Number(permissionId),
    };
    await this.service.assertUserInCompany(payload.userId, Number(companyId));
    await this.service.assertTargetNotSuper(request.user, { userId: payload.userId });
    await this.service.assertCanAssign(request.user, [payload.permissionId]);

    return this.service.activeUserPermission(payload, logParams);
  }

  @Patch('user/inactive/:userId/:permissionId')
  @Permissions('inactive_profile')
  async inactiveUserPermission(
    @Param('userId') userId: string,
    @Param('permissionId') permissionId: string,
    @Req() request: Request,
  ) {
    const { sub: Id, companyId } = request.user;
    const logParams = {
      userId: Id,
      companyId,
    };
    const payload = {
      userId: Number(userId),
      permissionId: Number(permissionId),
    };
    await this.service.assertUserInCompany(payload.userId, Number(companyId));
    await this.service.assertTargetNotSuper(request.user, { userId: payload.userId });
    await this.service.assertCanAssign(request.user, [payload.permissionId]);
    return this.service.inactiveUserPermission(payload, logParams);
  }

  @Patch('profile/active/:profileId/:permissionId')
  @Permissions('activate_profile')
  async activeProfilePermission(
    @Param('profileId') profileId: string,
    @Param('permissionId') permissionId: string,
    @Req() request: Request,
  ) {
    const { sub: Id, companyId } = request.user;
    const logParams = {
      userId: Id,
      companyId,
    };
    const payload = {
      profileId: Number(profileId),
      permissionId: Number(permissionId),
    };
    await this.service.assertProfileInCompany(payload.profileId, Number(companyId));
    await this.service.assertTargetNotSuper(request.user, { profileId: payload.profileId });
    await this.service.assertCanAssign(request.user, [payload.permissionId]);

    return this.service.activeProfilePermission(payload, logParams);
  }

  @Patch('profile/inactive/:profileId/:permissionId')
  @Permissions('inactive_profile')
  async inactiveProfilePermission(
    @Param('profileId') profileId: string,
    @Param('permissionId') permissionId: string,
    @Req() request: Request,
  ) {
    const { sub: Id, companyId } = request.user;
    const logParams = {
      userId: Id,
      companyId,
    };
    const payload = {
      profileId: Number(profileId),
      permissionId: Number(permissionId),
    };
    await this.service.assertProfileInCompany(payload.profileId, Number(companyId));
    await this.service.assertTargetNotSuper(request.user, { profileId: payload.profileId });
    await this.service.assertCanAssign(request.user, [payload.permissionId]);
    return this.service.inactiveProfilePermission(payload, logParams);
  }
}
