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
import { ImageService as Service } from './service';
// Import utils specifics
import { FileInterceptor } from '@nestjs/platform-express';
import {
  getMulterOptions,
  getOptimizedMulterOptions,
} from '../upload/upload.middleware';
import { ImageOptimizationInterceptor } from '../upload/image-optimization.interceptor';
// Import generic controller
import { Public } from 'src/auth/decorators/public.decorator';
// Import de configuraões




/** Rotas custom da galeria: exclusão (escopada), upload direto e proxy de leitura. */
@Controller('images')
export class ImageCustomController {
  constructor(private readonly Service: Service) {}

  // @UserPermission(`delete_${entity.permission}`) // comente para tirar permissao
  // @Public() // descomente para tornar publica
  @Delete(':id')
  async delete(@Param('id') id: number, @Req() request: Request) {
    const { sub: userId, companyId } = request.user;
    // Escopo pela empresa do ator: antes deletava qualquer imagem por id.
    return this.Service.deleteImage(Number(id), Number(companyId), { userId, companyId });
  }

  @Post('s3')
  @UseInterceptors(
    FileInterceptor('image', getOptimizedMulterOptions()),
    ImageOptimizationInterceptor,
  )
  async uploadToS3(@UploadedFile() file: Express.MulterS3.File) {
    // Se há arquivo, adiciona a URL ao DTO
    if (file && file.location) {
      return { imageUrl: file.location };
    }
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
