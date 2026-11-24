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
  ForbiddenException,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  certificateUnlockToken,
  isValidUnlockToken,
  onlyDigits,
} from './cpf-unlock';
import { parseCertificateVariables } from './render/variable-replacer';
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
import { CrudService } from '@adleron/crud-core';
import { defineWorksafeEntity } from 'src/common/crud/crud.module';
import { traineeCertificateEntity } from './rules.crud';
import { redactPublicCertificates } from './public-redaction';

const certificateDef = defineWorksafeEntity(traineeCertificateEntity);
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
    private readonly crud: CrudService<Request>,
  ) {}

  // --- Vitrine (lista pública) -------------------------------------------------
  // Substitui o GET /public gerado pela fábrica (controllers custom são
  // registrados antes): mesma consulta do CrudService, mas sem CPF e data de
  // nascimento no variableToReplace — ver public-redaction.ts.
  @Public()
  @Throttle({ default: { limit: 500, ttl: 60000 } })
  @Get('public')
  async listPublic(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
  ) {
    // `u` (selo de desbloqueio) não é filtro do CRUD
    const { u: _u, ...crudQuery } = query;
    const result = await this.crud.listPublic(
      certificateDef,
      crudQuery as never,
      req,
    );
    return redactPublicCertificates(result, query);
  }

  // --- Desbloqueio do certificado completo (LGPD) ---------------------------
  // Sem o selo, página/imagem/PDF saem com CPFs mascarados. O aluno digita o
  // CPF dele e recebe o selo. Contra tentativa e erro: 10/min por IP e, por
  // certificado, 5 erros travam por 1 h.

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('public/:key/unlock')
  @HttpCode(200)
  async unlockWithCpf(@Param('key') key: string, @Body() body: { cpf?: string }) {
    const cert = await this.renderer.findByKey(key);
    const failsKey = `sec:cert-unlock:fails:${cert.key}`;
    const fails = Number((await this.cacheService.get(failsKey)) || 0);
    if (fails >= 5) {
      throw new HttpException(
        'Muitas tentativas para este certificado. Tente de novo em 1 hora.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const typed = onlyDigits(body?.cpf);
    const vars = parseCertificateVariables(cert.variableToReplace) as Record<string, any>;
    const real = onlyDigits(vars.aluno_cpf?.value ?? cert.trainee?.cpf);
    if (typed.length !== 11 || !real || typed !== real) {
      await this.cacheService.increment(failsKey, 3600).catch(() => 0);
      throw new ForbiddenException('O CPF não confere com o deste certificado.');
    }
    await this.cacheService.del(failsKey).catch(() => undefined);
    return { u: certificateUnlockToken(cert.key) };
  }

  /** Empresa logada (tela de certificados) recebe o selo para ver/baixar completo. */
  @UserPermission('list_classes')
  @Get('unlock/:key')
  async unlockForCompany(@Param('key') key: string, @Req() req: Request) {
    const cert = await this.renderer.findByKey(key);
    const owner = await this.renderer.companyOf(cert.key);
    if (owner !== Number(req.user?.companyId)) {
      throw new NotFoundException('Certificado não encontrado');
    }
    return { u: certificateUnlockToken(cert.key) };
  }

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

  /**
   * Certificado cancelado: quem lê o QR de um certificado arquivado vê
   * "cancelado em …" (com motivo e, se reemitido, o novo) em vez de
   * "não encontrado", que parece documento falso. Só o mínimo, sem desenho.
   */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('public/:key/status')
  async getCancelledStatus(@Param('key') key: string) {
    return this.renderer.findCancelled(key);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('public/:key/image.png')
  async getCertificateImage(
    @Param('key') key: string,
    @Query('side') side: string,
    @Query('scale') scale: string,
    @Query('v') version: string,
    @Query('u') unlock: string,
    @Res() res: Response,
  ) {
    const cert = await this.renderer.findByKey(key);
    const full = isValidUnlockToken(cert.key, unlock);
    const which: CertificateSide = side === 'back' ? 'back' : 'front';
    // 2 = tela (1684 px); 3–4 = impressão
    const multiplier = [3, 4].includes(Number(scale)) ? Number(scale) : 2;
    const png = await this.renderer.renderPng(cert, which, multiplier, full);
    res
      .status(200)
      .set({
        'Content-Type': 'image/png',
        // exibida/aberta pelo front em outra origem (helmet usa same-origin)
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Content-Length': String(png.length),
        'Cache-Control': full
          ? 'private, max-age=3600'
          : version
            ? 'public, max-age=86400'
            : 'public, max-age=300',
        ETag: `"${this.renderer.version(cert)}-${which}-${multiplier}-${full ? 'f' : 'm'}"`,
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
    @Query('u') unlock: string,
    @Res() res: Response,
  ) {
    const cert = await this.renderer.findByKey(key);
    const full = isValidUnlockToken(cert.key, unlock);
    const pdf = await this.renderer.renderPdf(cert, full);
    const name = `${this.renderer.fileBaseName(cert)}.pdf`;
    res
      .status(200)
      .set({
        'Content-Type': 'application/pdf',
        // exibida/aberta pelo front em outra origem (helmet usa same-origin)
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Content-Length': String(pdf.length),
        'Content-Disposition': `${download === '0' ? 'inline' : 'attachment'}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': full
          ? 'private, max-age=3600'
          : version
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
  async sendCertificateByEmail(
    @Body() dto: SendCertificateEmailDto,
    @Req() request: Request,
  ) {
    return this.Service.sendCertificateByEmail(
      dto.traineeId,
      dto.certificateKey,
      Number(request.user?.companyId),
    );
  }
}
