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
    return this.Service.deleteImage(Number(id), Number(companyId), {
      userId,
      companyId,
    });
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
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'URL é obrigatória' });
      return;
    }

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      res.status(400).json({ error: 'URL inválida' });
      return;
    }
    if (!isAllowedProxyUrl(target)) {
      res.status(403).json({ error: 'Domínio não permitido' });
      return;
    }

    try {
      // redirect manual: um 3xx do bucket nunca é seguido (poderia levar a
      // metadata da nuvem ou à rede interna *.railway.internal).
      const response = await fetch(target.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        res.status(502).json({ error: 'Redirecionamento recusado' });
        return;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        res
          .status(response.status === 404 ? 404 : 502)
          .json({ error: 'Erro ao buscar imagem' });
        return;
      }

      const contentType = resolveImageContentType(
        response.headers.get('content-type'),
        target.pathname,
      );
      if (!contentType) {
        await response.body?.cancel().catch(() => undefined);
        res.status(415).json({ error: 'Tipo de arquivo não permitido' });
        return;
      }

      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > PROXY_MAX_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        res.status(413).json({ error: 'Imagem grande demais' });
        return;
      }

      const imageBuffer = await readBodyWithLimit(response, PROXY_MAX_BYTES);
      if (!imageBuffer) {
        res.status(413).json({ error: 'Imagem grande demais' });
        return;
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', imageBuffer.length.toString());
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.status(200).send(imageBuffer);
    } catch (error: any) {
      console.error('Erro no proxy de imagem:', error?.name, error?.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Erro ao processar imagem' });
      }
    }
  }
}

/** Teto de bytes lidos do bucket por requisição do proxy. */
export const PROXY_MAX_BYTES = 15 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 15_000;

/** Tipos aceitos: imagem raster. SVG fica de fora (script pela origem da API). */
const RASTER_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
]);

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

/**
 * Só o bucket público da própria API, por https e com hostname EXATO:
 * `<bucket>.s3.<region>.amazonaws.com` (formato gravado pelo upload),
 * `<bucket>.s3.amazonaws.com` (us-east-1/legado) e o path-style
 * `s3.<region>.amazonaws.com/<bucket>/` (aceito também pelo image-intake).
 */
export function isAllowedProxyUrl(target: URL): boolean {
  const bucket = (process.env.AWS_S3_BUCKET || '').toLowerCase();
  const region = (process.env.AWS_REGION || '').toLowerCase();
  if (!bucket) return false;
  if (target.protocol !== 'https:') return false;
  if (target.username || target.password) return false;
  if (target.port && target.port !== '443') return false;

  const host = target.hostname.toLowerCase();
  const virtualHosts = new Set([`${bucket}.s3.amazonaws.com`]);
  const pathHosts = new Set(['s3.amazonaws.com']);
  if (region) {
    virtualHosts.add(`${bucket}.s3.${region}.amazonaws.com`);
    pathHosts.add(`s3.${region}.amazonaws.com`);
  }
  if (virtualHosts.has(host)) return true;
  return pathHosts.has(host) && target.pathname.startsWith(`/${bucket}/`);
}

/**
 * Content-type final da resposta, ou null se não for imagem raster. Aceita
 * octet-stream/ausente quando a extensão é de imagem raster (objetos antigos
 * gravados sem ContentType).
 */
export function resolveImageContentType(
  header: string | null,
  pathname: string,
): string | null {
  const type = (header || '').split(';')[0].trim().toLowerCase();
  if (type.includes('svg')) return null;
  if (RASTER_IMAGE_TYPES.has(type))
    return type === 'image/jpg' ? 'image/jpeg' : type;
  if (
    type &&
    type !== 'application/octet-stream' &&
    type !== 'binary/octet-stream'
  ) {
    return null;
  }
  const ext = pathname.split('.').pop()?.toLowerCase() || '';
  return EXTENSION_TYPES[ext] ?? null;
}

/** Lê o corpo em streaming e aborta ao passar do teto (null = estourou). */
async function readBodyWithLimit(
  response: globalThis.Response,
  maxBytes: number,
): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
