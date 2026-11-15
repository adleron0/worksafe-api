import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { PlaceActor, PlaceService } from './place.service';

const actorOf = (req: Request): PlaceActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0) };
};
type Json = Record<string, unknown>;

/** Locais da empresa (CTs, bases) e o ponto no mapa dos clientes. */
@Controller('places')
export class PlaceController {
  constructor(private readonly places: PlaceService) {}

  @Permissions('view_locais') @Get()
  list(@Req() req: Request, @Query() query: Record<string, string>) { return this.places.list(actorOf(req), query ?? {}); }

  /** Endereço → ponto, sem gravar. */
  @Permissions('update_locais') @Post('geocode') @HttpCode(200)
  geocode(@Body() body: Json) { return this.places.geocode(body ?? {}); }

  @Permissions('view_locais') @Get('customers')
  customers(@Req() req: Request, @Query() query: Record<string, string>) { return this.places.customers(actorOf(req), query ?? {}); }

  @Permissions('update_locais') @Post('customers/locate-missing') @HttpCode(200)
  locateMissing(@Req() req: Request, @Body() body: Json) { return this.places.locateMissing(actorOf(req), body ?? {}); }

  @Permissions('update_locais') @Post('customers/:id/locate') @HttpCode(200)
  locateCustomer(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.places.locateCustomer(actorOf(req), id); }

  @Permissions('update_locais') @Put('customers/:id/point')
  setCustomerPoint(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.places.setCustomerPoint(actorOf(req), id, body ?? {}); }

  @Permissions('update_locais') @Post()
  create(@Req() req: Request, @Body() body: Json) { return this.places.create(actorOf(req), body ?? {}); }

  @Permissions('update_locais') @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Json) { return this.places.update(actorOf(req), id, body ?? {}); }

  @Permissions('update_locais') @Patch(':id/inactive')
  inactivate(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.places.setActive(actorOf(req), id, false); }

  @Permissions('update_locais') @Patch(':id/active')
  activate(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.places.setActive(actorOf(req), id, true); }
}
