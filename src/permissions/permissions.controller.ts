import { Controller, Get, Patch, Param, Req } from '@nestjs/common';
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

  @Patch('user/active/:userId/:permissionId')
  @Permissions('activate_profile')
  activeUserPermission(
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

    return this.service.activeUserPermission(payload, logParams);
  }

  @Patch('user/inactive/:userId/:permissionId')
  @Permissions('inactive_profile')
  inactiveUserPermission(
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
    return this.service.inactiveUserPermission(payload, logParams);
  }

  @Patch('profile/active/:profileId/:permissionId')
  @Permissions('activate_profile')
  activeProfilePermission(
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

    return this.service.activeProfilePermission(payload, logParams);
  }

  @Patch('profile/inactive/:profileId/:permissionId')
  @Permissions('inactive_profile')
  inactiveProfilePermission(
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
    return this.service.inactiveProfilePermission(payload, logParams);
  }
}
