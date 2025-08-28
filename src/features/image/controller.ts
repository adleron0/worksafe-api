import {
  Body,
  Controller,
  Delete,
  Get,
  Options,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
  Query,
  applyDecorators,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Request, Response } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
// Import entity template
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { IEntity } from './interfaces/interface';
import { ImageService as Service } from './service';
// Import utils specifics
import { FileInterceptor } from '@nestjs/platform-express';
import { getMulterOptions } from '../upload/upload.middleware';
// Import generic controller
import { GenericController } from 'src/features/generic/generic.controller';
import { Public } from 'src/auth/decorators/public.decorator';
// Import de configuraões
import { paramsIncludes } from './associations';
import {
  noCompany,
  getSearchParams,
  formaterPreUpdate,
  omitAttributes,
  hooksCreate,
  hooksUpdate,
} from './rules';

function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: 'Image' as keyof PrismaClient,
  name: 'Image',
  route: 'images',
  permission: 'images',
};

@Controller(entity.route)
export class ImageController extends GenericController<
  CreateDto,
  UpdateDto,
  IEntity,
  Service
> {
  constructor(private readonly Service: Service) {
    super(Service, entity);
  }

  // @UserPermission(`list_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @Get()
  async get(@Req() request: Request, @Query() query: any) {
    // Adiciona omitAttributes aos filtros se não estiver presente
    if (!query.omitAttributes) {
      query.omitAttributes = omitAttributes;
    }
    return super.get(request, query, paramsIncludes, noCompany);
  }

  // @UserPermission(`create_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @Post()
  @UseInterceptors(FileInterceptor('image', getMulterOptions('image-image')))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async create(
    @Req() request: Request,
    @Body() CreateDto: CreateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    console.log('🚀 ~ ImageController ~ create ~ CreateDto:', CreateDto);
    const search = getSearchParams(request, CreateDto);
    return super.create(request, CreateDto, file, search, hooksCreate);
  }

  // @UserPermission(`update_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @Put(':id')
  @UseInterceptors(FileInterceptor('image', getMulterOptions('image-image')))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  async update(
    @Param('id') id: number,
    @Req() request: Request,
    @Body() UpdateDto: UpdateDto,
    @UploadedFile() file?: Express.MulterS3.File,
  ) {
    const processedDto = formaterPreUpdate(UpdateDto);
    return super.update(id, request, processedDto, file, hooksUpdate);
  }

  // @UserPermission(`activate_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @Patch('active/:id')
  async activate(@Param('id') id: number, @Req() request: Request) {
    return super.activate(id, request);
  }

  // @UserPermission(`inactive_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @Patch('inactive/:id')
  async inactivate(@Param('id') id: number, @Req() request: Request) {
    return super.inactivate(id, request);
  }

  // @UserPermission(`delete_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @Delete(':id')
  async delete(@Param('id') id: number, @Req() request: Request) {
    const { sub: userId, companyId } = request.user;
    const logParams = {
      userId,
      companyId,
    };
    return this.Service.deleteImage(id, logParams);
  }

  @Public()
  @Options('proxy')
  async proxyOptions(@Res() res: Response) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(200).send();
  }

  @Post('s3')
  @UseInterceptors(FileInterceptor('image', getMulterOptions('uploads')))
  async uploadToS3(@UploadedFile() file: Express.MulterS3.File) {
    return this.Service.uploadToS3(file);
  }

  @Public()
  @Get('proxy')
  async proxyImage(@Query('url') url: string, @Res() res: Response) {
    try {
      if (!url) {
        res.status(400).json({ error: 'URL é obrigatória' });
        return;
      }

      // Validação básica de segurança - só aceita URLs do S3
      const allowedDomains = [
        'amazonaws.com',
        's3.amazonaws.com',
        '.s3.amazonaws.com',
        '.s3-accelerate.amazonaws.com',
      ];

      try {
        const urlObj = new URL(url);
        const isAllowed = allowedDomains.some((domain) =>
          urlObj.hostname.includes(domain),
        );

        if (!isAllowed) {
          res.status(403).json({ error: 'Domínio não permitido' });
          return;
        }
      } catch (urlError) {
        console.error('URL inválida:', urlError);
        res.status(400).json({ error: 'URL inválida' });
        return;
      }

      // Busca a imagem
      console.log('Buscando imagem do S3:', url);
      const response = await fetch(url);

      if (!response.ok) {
        console.error('Erro ao buscar do S3:', response.status);
        res.status(response.status).json({ error: 'Erro ao buscar imagem' });
        return;
      }

      const buffer = await response.arrayBuffer();
      const imageBuffer = Buffer.from(buffer);
      console.log('Imagem recebida, tamanho:', imageBuffer.length);

      // Detecta o tipo de conteúdo
      let contentType = response.headers.get('content-type') || 'image/png';

      // Fallback caso o S3 não retorne content-type correto
      if (
        contentType === 'application/octet-stream' ||
        !contentType.startsWith('image/')
      ) {
        const extension = url.split('.').pop()?.toLowerCase();
        switch (extension) {
          case 'jpg':
          case 'jpeg':
            contentType = 'image/jpeg';
            break;
          case 'png':
            contentType = 'image/png';
            break;
          case 'gif':
            contentType = 'image/gif';
            break;
          case 'webp':
            contentType = 'image/webp';
            break;
          case 'svg':
            contentType = 'image/svg+xml';
            break;
          default:
            contentType = 'image/png';
        }
      }

      console.log('Content-Type definido:', contentType);

      // Define headers CORS e cache
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', imageBuffer.length.toString());
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      // Envia a imagem como buffer binário
      res.status(200).send(imageBuffer);
    } catch (error) {
      console.error('Erro no proxy de imagem:', error);
      res.status(500).json({ error: 'Erro ao processar imagem' });
    }
  }
}
