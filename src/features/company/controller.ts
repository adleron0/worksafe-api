import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UploadedFiles,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
  Query,
  applyDecorators,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
// Import entity template
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { IEntity } from './interfaces/interface';
import { CompanyService as Service } from './service';
// Import utils specifics
import {
  FileInterceptor,
  FileFieldsInterceptor,
} from '@nestjs/platform-express';
import { getOptimizedMulterOptions } from '../upload/upload.middleware';
import { ImageOptimizationInterceptor } from '../upload/image-optimization.interceptor';
// Import generic controller
import { GenericController } from 'src/features/generic/generic.controller';
import { Public } from 'src/auth/decorators/public.decorator';
// Import cache
import { Cache, CacheEvictAll } from 'src/common/cache';
import { CacheService } from 'src/common/cache/cache.service';
// Import de configuraões
import { paramsIncludes } from './associations';
import { noCompany, omitAttributes, hooksUpdate, encryptFields } from './rules';

function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: 'Company' as keyof PrismaClient,
  name: 'Company',
  route: 'companies',
  permission: 'company',
};

@Controller(entity.route)
export class CompanyController extends GenericController<
  CreateDto,
  UpdateDto,
  IEntity,
  Service
> {
  constructor(
    private readonly Service: Service,
    // cacheService é usado pelos decorators de cache
    private readonly cacheService: CacheService,
  ) {
    super(Service, entity);
  }

  @UserPermission(`list_${entity.permission}`) // comente para tirar permissao
  @Get()
  async get(@Req() request: Request, @Query() query: any) {
    // Adiciona omitAttributes aos filtros se não estiver presente
    query.id = Number(request.user.companyId);
    return super.get(request, query, paramsIncludes, noCompany, encryptFields);
  }

  @Get('first-steps')
  async validateFirstSteps(@Req() request: Request) {
    const companyId = Number(request.user.companyId);
    const validation = await this.Service.validateFirstSteps(companyId);

    // Retorna o status detalhado de cada passo
    return {
      hasCourse: validation.hasCourse,
      hasInstructor: validation.hasInstructor,
      hasInstructorSignature: validation.hasInstructorSignature,
      hasCertificate: validation.hasCertificate,
      hasAsaasToken: validation.hasAsaasToken,
      hasClass: validation.hasClass,
      allCompleted:
        validation.hasCourse &&
        validation.hasInstructor &&
        validation.hasInstructorSignature &&
        validation.hasCertificate &&
        validation.hasAsaasToken &&
        validation.hasClass,
    };
  }

  @Public() // descomente para tornar publica
  @Cache({ prefix: 'companies', ttl: 172800 }) // cache (48 horas)
  @Get('public')
  async getPublic(@Req() request: Request, @Query() query: any) {
    // Adiciona omitAttributes aos filtros se não estiver presente
    if (!query.omitAttributes) {
      query.omitAttributes = omitAttributes;
    }
    return super.get(request, query, paramsIncludes, noCompany, encryptFields);
  }

  @UserPermission(`update_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @CacheEvictAll('companies:*', 'cache:*/companies*') // descomente para limpar cache
  @Put(':id')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'logo', maxCount: 1 },
        { name: 'favicon', maxCount: 1 },
      ],
      getOptimizedMulterOptions(),
    ),
    ImageOptimizationInterceptor,
  )
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async update(
    @Param('id') id: number,
    @Req() request: Request,
    @Body() UpdateDto: UpdateDto,
    @UploadedFiles()
    files?: {
      logo?: Express.MulterS3.File[];
      favicon?: Express.MulterS3.File[];
    },
  ) {
    // Remove campos de arquivo do DTO (serão processados pelo GenericService)
    delete UpdateDto.logo;
    delete UpdateDto.favicon;

    // Chama o update do GenericController passando os arquivos como um único parâmetro
    return super.update(id, request, UpdateDto, files, hooksUpdate);
  }
}
