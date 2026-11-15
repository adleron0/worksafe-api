import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { actorOf } from '../ai.controller';
import { McpOAuthService, apiUrl } from './mcp-oauth.service';

/** Telas do MCP no sistema: aprovar a conexão de um app de IA e gerenciar as conexões. */
@Controller('ai/mcp')
export class McpController {
  constructor(private readonly oauth: McpOAuthService) {}

  /** Endereço para colar no app de IA. */
  @Permissions('usar_mcp') @Get('info')
  info() { return { url: `${apiUrl()}/mcp`, enabled: process.env.MCP_ENABLED !== 'false' }; }

  @Get('requests')
  describe(@Query('pedido') key: string) { return this.oauth.describeRequest(this.oauth.assertKey(key)); }

  @Post('requests/decide') @HttpCode(200)
  decide(@Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.oauth.decide(actorOf(req), this.oauth.assertKey(body?.pedido), body?.approve === true || body?.approve === 'true');
  }

  @Permissions('usar_mcp') @Get('connections')
  connections(@Req() req: Request) { return this.oauth.connections(actorOf(req), false); }

  @Permissions('usar_mcp') @Patch('connections/:id/revoke')
  revoke(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.oauth.revoke(actorOf(req), id, false); }

  @Permissions('update_bots') @Get('connections/all')
  allConnections(@Req() req: Request) { return this.oauth.connections(actorOf(req), true); }

  @Permissions('update_bots') @Patch('connections/:id/revoke-any')
  revokeAny(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.oauth.revoke(actorOf(req), id, true); }

  @Permissions('update_bots') @Post('connections/revoke-all') @HttpCode(200)
  revokeAll(@Req() req: Request) { return this.oauth.revokeAll(actorOf(req)); }
}
