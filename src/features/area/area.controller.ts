import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
  UploadedFile,
  Query,
  Req,
  UnauthorizedException,
  Put,
  HttpCode,
} from '@nestjs/common';
import { AreaService } from './area.service';
import { CreateAreaDto } from './dto/createArea.dto';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { UpdateAreaDto } from './dto/updateArea.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { getMulterOptions } from 'src/features/upload/upload.middleware';
import { Request } from 'express';
import { ApiOkResponse } from '@nestjs/swagger';
import { CreateSubAreaDto } from './dto/createSubAreaDto';

@Controller('area')
export class AreaController {
  constructor(private readonly areaService: AreaService) {}

  @Post()
  @Permissions('create_area_inventarios')
  @UseInterceptors(FileInterceptor('image', getMulterOptions('areas-confinus')))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  create(
    @Body() createAreaDto: CreateAreaDto,
    @Req() request: Request,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    const { sub: userId, companyId } = request.user;
    const logParams = {
      userId,
      companyId,
    };
    return this.areaService.create(createAreaDto, logParams, file);
  }

  @Post('subarea')
  @Permissions('create_subarea_inventarios')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  createSubArea(@Body() createSubAreaDto: CreateSubAreaDto) {
    return this.areaService.createSubArea(createSubAreaDto);
  }

  @Get('list')
  @Permissions('list_area_inventarios')
  async findAll(@Req() request: Request, @Query() query: any) {
    const companyId = request.companyId;
    const { name, startedAt, endedAt, pagination, limit, active } = query;

    if (!companyId) {
      throw new UnauthorizedException('Company ID não encontrado.');
    }
    // Preparar filtros para a consulta
    const filters: any = { companyId };
    if (name) filters.name = name;
    filters.createdAt = [];
    if (startedAt) filters.createdAt.push(new Date(startedAt));
    if (endedAt) filters.createdAt.push(new Date(endedAt));
    if (pagination) filters.page = pagination;
    if (limit) filters.limit = limit;
    if (active) filters.active = active;

    const allAreas = await this.areaService.findAll(filters);
    return allAreas;
  }

  @Get(':areaId')
  @Permissions('list_area_inventarios')
  async findOne(@Param('areaId') areaId: string) {
    const area = await this.areaService.findOne(areaId);
    return area;
  }

  @Put(':areaId')
  @Permissions('update_area_inventarios')
  @UseInterceptors(FileInterceptor('image', getMulterOptions('areas-confinus')))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async update(
    @Param('areaId') areaId: string,
    @Body() updateAreaDto: UpdateAreaDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    const area = await this.areaService.update(areaId, updateAreaDto, file);
    return { message: 'Área atualizada com sucesso', area };
  }

  @Patch('inactive/:areaId')
  @Permissions('inactive_area_inventarios')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Area inativada com sucesso' })
  async inactivate(@Param('areaId') areaId: string) {
    await this.areaService.inactivateArea(areaId);
    return { message: `Area ${areaId} inativada com sucesso' })` };
  }

  @Patch('activate/:areaId')
  @Permissions('activate_area_inventarios')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Area ativada com sucesso' })
  async activate(@Param('areaId') areaId: string) {
    await this.areaService.activateArea(areaId);
    return { message: `Area ${areaId} ativada com sucesso` };
  }
}
