import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
  Query,
  applyDecorators,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaClient } from '@prisma/client';
import { Request, Response } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { Public } from 'src/auth/decorators/public.decorator';
// Import entity template
import { SendCertificateEmailDto } from './dto/send-email.dto';
import { TraineeCertificateService as Service } from './service';
import { ShareCardService } from './share-card.service';
import {
  CertificateRenderService,
  CertificateSide,
} from './render/certificate-render.service';
// Import utils specifics
import { FileInterceptor } from '@nestjs/platform-express';
// Import cache
import { CacheService } from 'src/common/cache/cache.service';
// Import de configuraões

/**
 * URL pública da API, para montar o og:image. Em produção pode ser fixada por
 * API_PUBLIC_URL; sem ela, vem do host da requisição (trust proxy ativo).
 */
function publicBaseUrl(req: Request) {
  if (process.env.API_PUBLIC_URL) return process.env.API_PUBLIC_URL;
  const host = req.get('x-forwarded-host') || req.get('host') || '';
  // Atrás do nginx-proxy o host pode chegar como endereço interno do Railway
  if (!host.includes('.') || host.endsWith('.internal')) {
    return 'https://api.worksafebrasil.com.br';
  }
  return `${req.protocol}://${host}`;
}

function UserPermission(permission: string) {
  return applyDecorators(Permissions(permission));
}

const entity = {
  model: 'TraineeCourseCertificate' as keyof PrismaClient,
  name: 'TraineeCertificate',
  route: 'trainee-certificate',
  permission: 'classes',
};

@Controller('trainee-certificate')
export class TraineeCertificateCustomController {
  constructor(
    private readonly Service: Service,
    private readonly shareCard: ShareCardService,
    private readonly renderer: CertificateRenderService,
    // cacheService é usado pelos decorators de cache
    private readonly cacheService: CacheService,
  ) {}

  // --- Compartilhamento em redes sociais -------------------------------------
  // Consumidas pelo middleware da Vercel (worksafe-front/middleware.ts), que
  // devolve og tags para robôs (LinkedIn, WhatsApp…) em /certificados/:key.
  // Só certificados públicos (consentimento + não arquivados); sem CPF.

  @Public()
  @Throttle({ default: { limit: 300, ttl: 60000 } })
  @Get('public/:key/meta')
  async getShareMeta(@Param('key') key: string, @Req() req: Request) {
    return this.shareCard.getMeta(key, publicBaseUrl(req));
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get('public/:key/og.png')
  async getShareCard(@Param('key') key: string, @Res() res: Response) {
    const png = await this.shareCard.getCard(key);
    res
      .status(200)
      .set({
        'Content-Type': 'image/png',
        // exibida/aberta pelo front em outra origem (helmet usa same-origin)
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Content-Length': String(png.length),
        // A URL leva ?v=<updatedAt>, então pode ser cacheada por bastante tempo
        'Cache-Control': 'public, max-age=86400, s-maxage=604800',
      })
      .send(png);
  }

  // --- Certificado renderizado na API ---------------------------------------
  // Mesma regra da página /certificados/<key>: quem tem a chave exata vê o
  // certificado (é a prova de autenticidade). Sem `?v=` o cache é curto; com
  // `?v=<updatedAt>` (o front sempre manda) pode ficar um dia no navegador.

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('public/:key/image.png')
  async getCertificateImage(
    @Param('key') key: string,
    @Query('side') side: string,
    @Query('scale') scale: string,
    @Query('v') version: string,
    @Res() res: Response,
  ) {
    const cert = await this.renderer.findByKey(key);
    const which: CertificateSide = side === 'back' ? 'back' : 'front';
    // 2 = tela (1684 px); 3–4 = impressão
    const multiplier = [3, 4].includes(Number(scale)) ? Number(scale) : 2;
    const png = await this.renderer.renderPng(cert, which, multiplier);
    res
      .status(200)
      .set({
        'Content-Type': 'image/png',
        // exibida/aberta pelo front em outra origem (helmet usa same-origin)
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Content-Length': String(png.length),
        'Cache-Control': version
          ? 'public, max-age=86400'
          : 'public, max-age=300',
        ETag: `"${this.renderer.version(cert)}-${which}-${multiplier}"`,
      })
      .send(png);
  }

  /** Miniatura leve (JPEG, 842 px de largura) para listagens. */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get('public/:key/thumb.jpg')
  async getCertificateThumb(
    @Param('key') key: string,
    @Query('v') version: string,
    @Res() res: Response,
  ) {
    const cert = await this.renderer.findByKey(key);
    const jpg = await this.renderer.renderThumb(cert);
    res
      .status(200)
      .set({
        'Content-Type': 'image/jpeg',
        // exibida/aberta pelo front em outra origem (helmet usa same-origin)
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Content-Length': String(jpg.length),
        'Cache-Control': version
          ? 'public, max-age=86400'
          : 'public, max-age=300',
      })
      .send(jpg);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Get('public/:key/certificate.pdf')
  async getCertificatePdf(
    @Param('key') key: string,
    @Query('download') download: string,
    @Query('v') version: string,
    @Res() res: Response,
  ) {
    const cert = await this.renderer.findByKey(key);
    const pdf = await this.renderer.renderPdf(cert);
    const name = `${this.renderer.fileBaseName(cert)}.pdf`;
    res
      .status(200)
      .set({
        'Content-Type': 'application/pdf',
        // exibida/aberta pelo front em outra origem (helmet usa same-origin)
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Content-Length': String(pdf.length),
        'Content-Disposition': `${download === '0' ? 'inline' : 'attachment'}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': version
          ? 'public, max-age=86400'
          : 'public, max-age=300',
      })
      .send(pdf);
  }

  // Não é usada por nenhuma das telas públicas de certificado (que só leem
  // via GET /public) — disparar reenvio de e-mail deve exigir autenticação.
  @UserPermission(`update_${entity.permission}`)
  @Post('send-email')
  @UseInterceptors(FileInterceptor('none')) // Interceptor para processar FormData
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async sendCertificateByEmail(@Body() dto: SendCertificateEmailDto) {
    return this.Service.sendCertificateByEmail(
      dto.traineeId,
      dto.certificateKey,
    );
  }
}
