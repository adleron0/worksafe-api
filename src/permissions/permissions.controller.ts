import { Controller, Get, Patch, Param, Req } from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { Request } from 'express';

@Controller('permissions')
export class PermissionsController {
  constructor(private readonly service: PermissionsService) {}

  @Get('list')
  @Roles('admin')
  async getAllPermissions(@Req() request: Request) {
    const companyId = request.companyId;
    const allPermissions = await this.service.getAllPermissions(companyId);
    return allPermissions;
  }

  @Patch('active/:userId/:permissionId')
  @Roles('admin')
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

  @Patch('inactive/:userId/:permissionId')
  @Roles('admin')
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
}
