import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as sharp from 'sharp';
import satori from 'satori';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  CertificateRenderService,
  RENDER_VERSION,
} from './render/certificate-render.service';
import { parseCertificateVariables } from './render/variable-replacer';

/**
 * Preview de certificado para redes sociais (LinkedIn, WhatsApp, Facebook…).
 *
 * - `getMeta`  → título/descrição/imagem/URL que o middleware da Vercel põe
 *   nas og tags de /certificados/:key quando quem pede é um robô.
 * - `getCard`  → PNG 1200×630 (proporção 1.91:1 que o LinkedIn exibe sem
 *   cortar), com a frente do certificado renderizada na API
 *   (`CertificateRenderService`); se o render falhar, usa o `pdfUrl` antigo e,
 *   sem ele, um cartão só com texto.
 *
 * Só certificados públicos: consentimento dado e não arquivados — mesmo filtro
 * da vitrine (`listPublic`). Nunca expõe CPF ou outros dados das variáveis.
 */

export interface CertificateShareMeta {
  key: string;
  title: string;
  description: string;
  imageUrl: string;
  url: string;
  studentName: string;
  courseName: string;
  companyName: string;
}

type Variables = Record<string, { value?: unknown } | undefined>;

const WIDTH = 1200;
const HEIGHT = 630;
const COLORS = {
  bg: '#0b0f14',
  panel: '#ffffff',
  accent: '#7ac943',
  text: '#ffffff',
  muted: '#9aa4ae',
  soft: '#e6e9ec',
};
const FRONT_URL = (
  process.env.FRONT_PUBLIC_URL || 'https://sistema.worksafebrasil.com.br'
).replace(/\/$/, '');
const IMAGE_TIMEOUT_MS = 5000;
const CACHE_MAX = 200;

/** Mínimo de JSX sem JSX: satori aceita objetos { type, props }. */
type Node = { type: string; props: Record<string, unknown> };
const h = (
  type: string,
  style: Record<string, unknown>,
  children?: unknown,
  extra: Record<string, unknown> = {},
): Node => ({ type, props: { style, children, ...extra } });

@Injectable()
export class ShareCardService {
  private readonly logger = new Logger(ShareCardService.name);
  private fonts?: { name: string; data: Buffer; weight: 400 | 700 }[];
  private readonly cache = new Map<string, Buffer>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: CertificateRenderService,
  ) {}

  async getMeta(
    key: string,
    apiBaseUrl: string,
  ): Promise<CertificateShareMeta> {
    const cert = await this.findPublic(key);
    const info = this.extractInfo(cert);
    const version = `${new Date(cert.updatedAt).getTime()}-${RENDER_VERSION}`;

    const details = [
      info.hours && `carga horária de ${info.hours}`,
      info.date && `concluído em ${info.date}`,
    ].filter(Boolean);

    return {
      key: cert.key,
      title: `Certificado de ${info.studentName} — ${info.courseName}`,
      description:
        `${info.companyName} certifica que ${info.studentName} concluiu o curso ` +
        `${info.courseName}${details.length ? ` (${details.join(', ')})` : ''}. ` +
        `Verifique a autenticidade no sistema oficial.`,
      imageUrl: `${apiBaseUrl.replace(/\/$/, '')}/trainee-certificate/public/${cert.key}/og.png?v=${version}`,
      url: `${FRONT_URL}/certificados/${cert.key}`,
      studentName: info.studentName,
      courseName: info.courseName,
      companyName: info.companyName,
    };
  }

  async getCard(key: string): Promise<Buffer> {
    const cert = await this.findPublic(key);
    const cacheKey = `${cert.key}:${new Date(cert.updatedAt).getTime()}:${RENDER_VERSION}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const info = this.extractInfo(cert);
    const [certImage, logo] = await Promise.all([
      this.certificateImage(cert),
      info.logoUrl ? this.loadImage(info.logoUrl, 200) : null,
    ]);

    const tree = certImage
      ? this.layoutWithImage(info, certImage, logo)
      : this.layoutTextOnly(info, logo);

    const svg = await satori(tree as never, {
      width: WIDTH,
      height: HEIGHT,
      fonts: this.loadFonts(),
    });
    const png = await sharp(Buffer.from(svg))
      .png({ compressionLevel: 9 })
      .toBuffer();

    if (this.cache.size >= CACHE_MAX) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
    this.cache.set(cacheKey, png);
    return png;
  }

  // ---------------------------------------------------------------------------

  /** Frente do certificado renderizada na API; `pdfUrl` antigo como reserva. */
  private async certificateImage(
    cert: Awaited<ReturnType<ShareCardService['findPublic']>>,
  ) {
    try {
      const full = await this.renderer.findByKey(cert.key);
      const png = await this.renderer.renderPng(full, 'front', 2);
      const { data, info } = await sharp(png)
        .resize({ width: 1400, withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true });
      return {
        src: `data:image/png;base64,${data.toString('base64')}`,
        width: info.width,
        height: info.height,
      };
    } catch (err) {
      this.logger.warn(
        `Render do certificado ${cert.key} falhou no cartão: ${(err as Error).message}`,
      );
      return cert.pdfUrl ? this.loadImage(cert.pdfUrl, 1400) : null;
    }
  }

  private async findPublic(key: string) {
    // key é UUID; qualquer outra coisa nem chega ao banco
    if (!/^[0-9a-f-]{36}$/i.test(key)) {
      throw new NotFoundException('Certificado não encontrado');
    }
    const cert = await this.prisma.traineeCourseCertificate.findFirst({
      where: { key, showOnWebsiteConsent: true, inactiveAt: null },
      select: {
        key: true,
        pdfUrl: true,
        updatedAt: true,
        variableToReplace: true,
        trainee: { select: { name: true } },
        course: { select: { name: true } },
        company: {
          select: { comercial_name: true, corporate_name: true, logoUrl: true },
        },
      },
    });
    if (!cert) throw new NotFoundException('Certificado não encontrado');
    return cert;
  }

  private extractInfo(
    cert: Awaited<ReturnType<ShareCardService['findPublic']>>,
  ) {
    const vars = parseCertificateVariables(cert.variableToReplace) as Variables;
    const v = (name: string) => {
      const value = vars[name]?.value;
      return typeof value === 'string' || typeof value === 'number'
        ? String(value).trim()
        : '';
    };
    return {
      studentName:
        v('inscricao_nome') ||
        cert.trainee?.name ||
        titleCase(v('aluno_nome')) ||
        'Aluno',
      courseName: cert.course?.name || titleCase(v('curso_nome')) || 'Curso',
      companyName:
        cert.company?.comercial_name ||
        cert.company?.corporate_name ||
        'WorkSafe Brasil',
      hours: v('turma_carga_horaria'),
      date: v('turma_data_fim') || v('certificado_emissao'),
      logoUrl: cert.company?.logoUrl || '',
    };
  }

  /** Baixa, redimensiona e converte para PNG (satori não lê webp). */
  private async loadImage(url: string, maxWidth: number) {
    try {
      const res = await fetch(url.replace(/^http:\/\//, 'https://'), {
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const input = Buffer.from(await res.arrayBuffer());
      const { data, info } = await sharp(input)
        .resize({ width: maxWidth, withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true });
      return {
        src: `data:image/png;base64,${data.toString('base64')}`,
        width: info.width,
        height: info.height,
      };
    } catch (err) {
      this.logger.warn(
        `Imagem ignorada no cartão (${url}): ${(err as Error).message}`,
      );
      return null;
    }
  }

  private loadFonts() {
    if (!this.fonts) {
      const dir = join(process.cwd(), 'assets', 'fonts');
      const read = (f: string) => readFileSync(join(dir, f));
      this.fonts = [
        {
          name: 'Montserrat',
          data: read('montserrat-400.ttf'),
          weight: 400,
        },
        { name: 'Montserrat', data: read('montserrat-700.ttf'), weight: 700 },
        {
          name: 'Bebas Neue',
          data: read('bebas-neue-400.ttf'),
          weight: 400,
        },
      ];
    }
    return this.fonts;
  }

  // --- layouts ---------------------------------------------------------------

  private header(info: { companyName: string }, logo: Img | null) {
    return h(
      'div',
      { display: 'flex', alignItems: 'center', gap: 14 },
      [
        // Etiqueta branca: logos costumam ser escuros e sumiriam no fundo
        logo
          ? h(
              'div',
              {
                display: 'flex',
                background: COLORS.panel,
                borderRadius: 8,
                padding: '6px 12px',
              },
              h('img', { height: 32, objectFit: 'contain' }, undefined, {
                src: logo.src,
                height: 32,
                width: Math.round((logo.width / logo.height) * 32),
              }),
            )
          : null,
        h(
          'div',
          {
            display: 'flex',
            fontFamily: 'Montserrat',
            fontWeight: 700,
            fontSize: 18,
            letterSpacing: 3,
            color: COLORS.accent,
            textTransform: 'uppercase',
          },
          'Certificado verificado',
        ),
      ].filter(Boolean),
    );
  }

  private textBlock(
    info: ReturnType<ShareCardService['extractInfo']>,
    sizes: { name: number; course: number },
  ) {
    const details = [info.hours, info.date && `Concluído em ${info.date}`]
      .filter(Boolean)
      .join('  ·  ');
    return [
      h(
        'div',
        {
          display: 'flex',
          fontFamily: 'Bebas Neue',
          fontSize: fitSize(info.studentName, sizes.name),
          lineHeight: 1,
          color: COLORS.text,
        },
        info.studentName,
      ),
      h(
        'div',
        {
          display: 'flex',
          fontFamily: 'Montserrat',
          fontWeight: 700,
          fontSize: sizes.course,
          lineHeight: 1.2,
          color: COLORS.soft,
        },
        info.courseName,
      ),
      details
        ? h(
            'div',
            {
              display: 'flex',
              fontFamily: 'Montserrat',
              fontSize: 20,
              color: COLORS.muted,
            },
            details,
          )
        : null,
    ].filter(Boolean);
  }

  private footer(info: { companyName: string }) {
    return h(
      'div',
      {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        fontFamily: 'Montserrat',
        fontSize: 18,
        color: COLORS.muted,
      },
      [
        h(
          'div',
          { display: 'flex', fontWeight: 700, color: COLORS.soft },
          info.companyName,
        ),
        h('div', { display: 'flex' }, FRONT_URL.replace(/^https?:\/\//, '')),
      ],
    );
  }

  private layoutWithImage(
    info: ReturnType<ShareCardService['extractInfo']>,
    img: Img,
    logo: Img | null,
  ) {
    // Caixa do certificado à esquerda, mantendo a proporção da imagem
    const boxH = 520;
    const boxW = Math.min(680, Math.round((img.width / img.height) * boxH));
    return h(
      'div',
      {
        width: WIDTH,
        height: HEIGHT,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        background: COLORS.bg,
        padding: '0 48px',
        gap: 44,
        borderLeft: `10px solid ${COLORS.accent}`,
      },
      [
        h(
          'div',
          {
            display: 'flex',
            width: boxW,
            height: boxH,
            background: COLORS.panel,
            borderRadius: 10,
            padding: 8,
            boxShadow: '0 20px 50px rgba(0,0,0,0.55)',
          },
          h(
            'img',
            { width: '100%', height: '100%', objectFit: 'contain' },
            undefined,
            {
              src: img.src,
            },
          ),
        ),
        h(
          'div',
          {
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            flex: 1,
            height: boxH,
          },
          [
            this.header(info, logo),
            h(
              'div',
              { display: 'flex', flexDirection: 'column', gap: 16 },
              this.textBlock(info, { name: 64, course: 26 }),
            ),
            this.footer(info),
          ],
        ),
      ],
    );
  }

  private layoutTextOnly(
    info: ReturnType<ShareCardService['extractInfo']>,
    logo: Img | null,
  ) {
    return h(
      'div',
      {
        width: WIDTH,
        height: HEIGHT,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: COLORS.bg,
        padding: '56px 72px',
        borderLeft: `14px solid ${COLORS.accent}`,
      },
      [
        this.header(info, logo),
        h('div', { display: 'flex', flexDirection: 'column', gap: 22 }, [
          h(
            'div',
            {
              display: 'flex',
              fontFamily: 'Bebas Neue',
              fontSize: 54,
              letterSpacing: 4,
              color: COLORS.accent,
            },
            'Certificado de conclusão',
          ),
          ...this.textBlock(info, { name: 104, course: 38 }),
        ]),
        this.footer(info),
      ],
    );
  }
}

type Img = { src: string; width: number; height: number };

function titleCase(s: string) {
  return s
    .toLowerCase()
    .replace(
      /(^|\s)(\p{L})/gu,
      (_m, sp: string, ch: string) => sp + ch.toUpperCase(),
    );
}

/** Reduz a fonte do nome para caber em até ~2 linhas sem estourar o cartão. */
function fitSize(text: string, base: number) {
  const len = text.length;
  if (len <= 18) return base;
  if (len <= 26) return Math.round(base * 0.85);
  if (len <= 36) return Math.round(base * 0.72);
  return Math.round(base * 0.6);
}
