import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Image as NodeImage } from 'canvas';
import * as sharp from 'sharp';
// pdfkit é CommonJS com `module.exports = PDFDocument` (sem esModuleInterop)
// eslint-disable-next-line @typescript-eslint/no-require-imports
import PDFDocument = require('pdfkit');
import { PrismaService } from 'src/prisma/prisma.service';
import {
  getLogicalCanvasSize,
  isTextboxType,
  setupFabric,
} from './fabric-setup';
import {
  CertificateVariables,
  parseCertificateVariables,
  replaceInCanvasJSON,
} from './variable-replacer';
import { createHash } from 'crypto';
import { resolveHighlight } from '../highlight';
import {
  drawHighlightSeal,
  SEAL_HEIGHT_RATIO,
  SealBox,
} from './highlight-seal';
import { drawStaticFoil } from './highlight-static';
import { QR_STYLES, QrStyle, styledQrPng } from './qr-styled';
import {
  certificateUnlockToken,
  maskCertificateVariables,
} from '../cpf-unlock';
import { layoutInstructorSlots } from './instructor-slots';
import { applyConditionalVisibility } from './conditional-visibility';
import { drawExpiredMark } from './expired-mark';

/**
 * Render do certificado na API (mesmo JSON do Fabric que o visualizador do
 * front usa), para:
 * - a página pública e as áreas logadas exibirem uma imagem pronta (sem baixar
 *   fontes, assinaturas e o Fabric no navegador);
 * - downloads de PNG/PDF;
 * - o cartão de compartilhamento (og.png).
 *
 * Cache em memória por `key + updatedAt + RENDER_VERSION`: editar o
 * certificado (ou mudar o renderer) gera arquivos novos sozinho.
 */

/** Suba quando o resultado do render mudar, para invalidar caches/URLs. */
export const RENDER_VERSION = 18;

export type CertificateSide = 'front' | 'back';

const FRONT_URL = (
  process.env.FRONT_PUBLIC_URL || 'https://sistema.worksafebrasil.com.br'
).replace(/\/$/, '');
const IMAGE_TIMEOUT_MS = 6000;
const MAX_CONCURRENT_RENDERS = 2;
const CACHE_MAX_BYTES = 80 * 1024 * 1024;
const SOURCE_CACHE_MAX_BYTES = 40 * 1024 * 1024;

type CertificateRecord = Awaited<
  ReturnType<CertificateRenderService['findByKey']>
>;

@Injectable()
export class CertificateRenderService {
  private readonly logger = new Logger(CertificateRenderService.name);
  private readonly cache = new Map<string, Buffer>();
  private cacheBytes = 0;
  private readonly inflight = new Map<string, Promise<Buffer>>();
  private readonly sourceImages = new Map<string, SourceImage>();
  private sourceBytes = 0;
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly prisma: PrismaService) {}

  /** Certificado vivo, pela chave exata (mesma regra da página /certificados/<key>). */
  async findByKey(key: string, opts: { requireConsent?: boolean } = {}) {
    if (!/^[0-9a-f-]{36}$/i.test(key)) {
      throw new NotFoundException('Certificado não encontrado');
    }
    const cert = await this.prisma.traineeCourseCertificate.findFirst({
      where: {
        key,
        inactiveAt: null,
        ...(opts.requireConsent ? { showOnWebsiteConsent: true } : {}),
      },
      select: {
        key: true,
        updatedAt: true,
        createdAt: true,
        expirationDate: true,
        fabricJsonFront: true,
        fabricJsonBack: true,
        canvasWidth: true,
        canvasHeight: true,
        variableToReplace: true,
        trainee: { select: { name: true, cpf: true } },
        course: { select: { name: true } },
        highlightStudent: true,
        highlightTheme: true,
        highlightLabel: true,
        highlightPattern: true,
        highlightBorder: true,
        class: {
          select: {
            highlightTheme: true,
            highlightLabel: true,
            highlightPattern: true,
            highlightBorder: true,
          },
        },
      },
    });
    if (!cert) throw new NotFoundException('Certificado não encontrado');
    return cert;
  }

  /** Empresa dona do certificado (para a tela logada pedir o selo). */
  async companyOf(key: string): Promise<number | null> {
    const row = await this.prisma.traineeCourseCertificate.findFirst({
      where: { key },
      select: { companyId: true },
    });
    return row?.companyId ?? null;
  }

  /**
   * Certificado cancelado (arquivado): a página pública mostra "cancelado" com
   * o mínimo — aluno, curso, data, motivo e, se reemitido, a chave do novo.
   * Nada do desenho nem do CPF.
   */
  async findCancelled(key: string) {
    if (!/^[0-9a-f-]{36}$/i.test(key)) {
      throw new NotFoundException('Certificado não encontrado');
    }
    const cert = await this.prisma.traineeCourseCertificate.findFirst({
      where: { key, inactiveAt: { not: null } },
      select: {
        key: true,
        inactiveAt: true,
        cancelReason: true,
        replacedByKey: true,
        createdAt: true,
        trainee: { select: { name: true } },
        course: { select: { name: true, icon: true, color: true } },
        company: { select: { comercial_name: true } },
      },
    });
    if (!cert) throw new NotFoundException('Certificado não encontrado');
    // o substituto só conta se existir e estiver vivo
    let replacedByKey: string | null = null;
    if (cert.replacedByKey) {
      const next = await this.prisma.traineeCourseCertificate.findFirst({
        where: { key: cert.replacedByKey, inactiveAt: null },
        select: { key: true },
      });
      replacedByKey = next?.key ?? null;
    }
    return {
      status: 'cancelado' as const,
      key: cert.key,
      canceledAt: cert.inactiveAt,
      issuedAt: cert.createdAt,
      reason: cert.cancelReason,
      replacedByKey,
      traineeName: cert.trainee?.name ?? null,
      course: cert.course,
      companyName: cert.company?.comercial_name ?? null,
    };
  }

  /** Vencido = data de validade já passou (sem validade nunca vence). */
  isExpired(cert: { expirationDate?: Date | string | null }) {
    return (
      !!cert.expirationDate &&
      new Date(cert.expirationDate).getTime() < Date.now()
    );
  }

  /** Versão para compor URLs cacheáveis (`?v=`). */
  version(
    cert: { updatedAt: Date | string } & Parameters<typeof resolveHighlight>[0],
  ) {
    // vencer muda a imagem (marca VENCIDO) sem tocar no certificado
    const base = `${new Date(cert.updatedAt).getTime()}-${RENDER_VERSION}${this.isExpired(cert as any) ? '-vencido' : ''}`;
    // o destaque da turma muda sem tocar no certificado: entra na versão
    const h = resolveHighlight(cert);
    return h ? `${base}-${highlightSignature(h)}` : base;
  }

  hasBack(cert: CertificateRecord) {
    const back = parseJson(cert.fabricJsonBack);
    return Array.isArray(back?.objects) && back.objects.length > 0;
  }

  fileBaseName(cert: CertificateRecord) {
    const vars = parseCertificateVariables(cert.variableToReplace);
    const student =
      cert.trainee?.name || String(vars.aluno_nome?.value || 'aluno');
    const course = cert.course?.name || 'certificado';
    return `Certificado - ${course} - ${student}`
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w .-]+/g, '')
      .trim();
  }

  /** PNG de um lado. `scale` 2 = 1684×1190 em paisagem. */
  /**
   * `full` = certificado completo (CPFs à vista e QR com o selo que desbloqueia).
   * Sem ele, CPFs mascarados e QR simples — ver cpf-unlock.ts.
   */
  async renderPng(
    cert: CertificateRecord,
    side: CertificateSide = 'front',
    scale = 2,
    full = false,
  ): Promise<Buffer> {
    if (side === 'back' && !this.hasBack(cert)) {
      throw new NotFoundException('Certificado sem verso');
    }
    return this.cached(
      `${this.version(cert)}:${cert.key}:${side}:${scale}:${full ? 'full' : 'masked'}`,
      () => this.limit(() => this.renderSide(cert, side, scale, full)),
    );
  }

  /** Miniatura JPEG da frente (listagens). */
  async renderThumb(cert: CertificateRecord): Promise<Buffer> {
    return this.cached(`${this.version(cert)}:${cert.key}:thumb`, async () => {
      const png = await this.renderPng(cert, 'front', 1, false);
      return sharp(png).jpeg({ quality: 82 }).toBuffer();
    });
  }

  /** PDF com frente (e verso, se houver), uma página A4 por lado. */
  async renderPdf(cert: CertificateRecord, full = false): Promise<Buffer> {
    const mode = full ? 'full' : 'masked';
    return this.cached(`${this.version(cert)}:${cert.key}:pdf:${mode}`, async () => {
      const sides: CertificateSide[] = this.hasBack(cert)
        ? ['front', 'back']
        : ['front'];
      const { width, height } = getLogicalCanvasSize(
        cert.canvasWidth,
        cert.canvasHeight,
      );
      const pages: Buffer[] = [];
      for (const side of sides) {
        const png = await this.renderPng(cert, side, 3, full);
        pages.push(await sharp(png).jpeg({ quality: 92 }).toBuffer());
      }
      return new Promise<Buffer>((resolve, reject) => {
        const doc = new PDFDocument({
          size: [width, height],
          margin: 0,
          autoFirstPage: false,
          info: { Title: this.fileBaseName(cert), Creator: 'WorkSafe Brasil' },
        });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        for (const page of pages) {
          doc.addPage({ size: [width, height], margin: 0 });
          doc.image(page, 0, 0, { width, height });
        }
        doc.end();
      });
    });
  }

  // ---------------------------------------------------------------------------

  private async renderSide(
    cert: CertificateRecord,
    side: CertificateSide,
    scale: number,
    full = false,
  ): Promise<Buffer> {
    const started = Date.now();
    const fabric = setupFabric();
    const raw = parseJson(
      side === 'front' ? cert.fabricJsonFront : cert.fabricJsonBack,
    );
    if (!raw) throw new NotFoundException('Certificado sem desenho');

    const parsed = parseCertificateVariables(cert.variableToReplace);
    const variables = full ? parsed : maskCertificateVariables(parsed);
    const json = replaceInCanvasJSON(
      layoutInstructorSlots(
        applyConditionalVisibility(raw, variables),
        variables,
      ),
      variables,
    );
    const highlight = resolveHighlight(cert);
    // Marcador "Selo" do editor: com destaque recebe o selo de destaque
    // (desenhado depois); sem destaque, a imagem padrão do marcador, se houver.
    const sealMarker = (json.objects || []).find(
      (o: any) => o?.isHighlightSealPlaceholder,
    );
    json.objects = (json.objects || []).flatMap((o: any) => {
      if (!o?.isHighlightSealPlaceholder) return [o];
      if (highlight || !o.sealDefaultSrc) return [];
      const w = (o.width || 120) * (o.scaleX || 1);
      const h = (o.height || 120) * (o.scaleY || 1);
      return [
        {
          type: 'Image',
          version: '6.7.1',
          originX: 'center',
          originY: 'center',
          left: (o.left || 0) + w / 2,
          top: (o.top || 0) + h / 2,
          scaleX: 1,
          scaleY: 1,
          angle: o.angle || 0,
          src: String(o.sealDefaultSrc),
          targetWidth: w,
          targetHeight: h,
          name: 'selo_padrao',
        },
      ];
    });
    const images = await this.resolveImages(json, cert.key, scale, full);
    const tImages = Date.now();

    const { width, height } = getLogicalCanvasSize(
      cert.canvasWidth,
      cert.canvasHeight,
    );
    if (!json.objects.some((o: any) => o.name === 'backgroundRect')) {
      json.objects.unshift({
        type: 'Rect',
        left: 0,
        top: 0,
        width,
        height,
        fill: 'white',
        strokeWidth: 0,
        name: 'backgroundRect',
      });
    }

    const canvas = new fabric.StaticCanvas(null, {
      width,
      height,
      enableRetinaScaling: false,
      renderOnAddRemove: false,
    });
    try {
      await canvas.loadFromJSON(json);
      this.attachImages(fabric, canvas, images);
      // O JSON pode trazer width/height do editor antigo (com zoom, ex.: 1369)
      canvas.setDimensions({ width: width * scale, height: height * scale });
      canvas.setZoom(scale);
      if (!canvas.backgroundImage) canvas.backgroundColor = '#ffffff';
      for (const obj of canvas.getObjects() as any[]) {
        if (isTextboxType(obj.type) && obj.width > 0) {
          obj.initDimensions();
          fitTextToMaxHeight(obj);
        }
      }
      const tLoad = Date.now();
      canvas.renderAll();
      // destaque: efeito estático (frente e verso) e selo (só na frente)
      if (highlight) {
        const node = (canvas as any).getNodeCanvas();
        drawStaticFoil(
          node.getContext('2d'),
          node.width,
          node.height,
          highlight.theme,
          highlight.pattern,
          `${cert.key}:${side}`,
          highlight.border,
        );
      }
      if (highlight && side === 'front') {
        const node = (canvas as any).getNodeCanvas();
        drawHighlightSeal(
          node.getContext('2d'),
          sealBox(sealMarker, width, height, scale),
          highlight.theme,
          highlight.label,
          null, // sem legenda sob o selo (a validação fica na área do QR)
          new Date(cert.createdAt).getFullYear(),
        );
      }
      if (this.isExpired(cert)) {
        const node = (canvas as any).getNodeCanvas();
        drawExpiredMark(
          node.getContext('2d'),
          node.width,
          node.height,
          new Date(cert.expirationDate as any),
        );
      }
      const tRender = Date.now();
      // Em fabric/node o StaticCanvas expõe o canvas nativo (node-canvas)
      const png: Buffer = (canvas as any)
        .getNodeCanvas()
        .toBuffer('image/png', { compressionLevel: 6 });
      this.logger.log(
        `Certificado ${cert.key} (${side}, ${scale}x) em ${Date.now() - started}ms ` +
          `(imagens ${tImages - started}, load ${tLoad - tImages}, desenho ${tRender - tLoad}, png ${Date.now() - tRender})`,
      );
      return png;
    } finally {
      canvas.dispose();
    }
  }

  /**
   * Baixa todas as imagens antes do load (timeout, webp/svg → raster, cache de
   * download), reduz cada uma ao tamanho em que é desenhada, ajusta a escala das
   * assinaturas ao placeholder e troca os placeholders de QR Code pelo QR de
   * validação. Imagem que falha é removida — nunca derruba o render.
   *
   * No JSON a imagem fica com `src: ''` + `renderImageId`; o elemento é
   * entregue já decodificado depois do load (`attachImages`). Passar data URLs
   * grandes pelo jsdom custava ~1–2 s por lado só para parsear a URL.
   */
  private async resolveImages(
    json: any,
    key: string,
    scale: number,
    full = false,
  ) {
    const images = new Map<string, PreparedImage>();
    const attach = (obj: any, img: PreparedImage) => {
      const id = String(images.size + 1);
      images.set(id, img);
      Object.assign(obj, {
        src: '',
        crossOrigin: null,
        renderImageId: id,
        width: img.width,
        height: img.height,
      });
    };

    // um QR por estilo (o marcador pode pedir `qrStyle`, ex.: "selo")
    const qrs = new Map<QrStyle, ReturnType<typeof styledQrPng>>();
    const qrImage = (wanted?: string) => {
      const style: QrStyle = QR_STYLES.includes(wanted as QrStyle)
        ? (wanted as QrStyle)
        : (process.env.CERT_QR_STYLE as QrStyle) || 'suave';
      if (!qrs.has(style))
        qrs.set(
          style,
          styledQrPng(
            full
              ? `${FRONT_URL}/certificados/${key}?u=${certificateUnlockToken(key)}`
              : `${FRONT_URL}/certificados/${key}`,
            { size: 600, style },
          ),
        );
      return qrs.get(style)!;
    };

    const walk = async (objects: any[], nested = false): Promise<any[]> => {
      const out: any[] = [];
      for (const obj of objects) {
        if (obj.isQRCodePlaceholder) {
          const w = (obj.width || 120) * (obj.scaleX || 1);
          const h = (obj.height || 120) * (obj.scaleY || 1);
          const qrObj: any = {
            type: 'Image',
            left: obj.left,
            top: obj.top,
            scaleX: w / 600,
            scaleY: h / 600,
            angle: obj.angle || 0,
            name: `qrcode_${obj.qrCodeName}`,
          };
          attach(qrObj, qrImage(obj.qrStyle));
          out.push(qrObj);
          continue;
        }
        if (String(obj.type).toLowerCase() === 'image' && obj.src) {
          const source = await this.fetchImage(obj.src);
          if (!source) continue;
          if (obj.targetWidth && obj.targetHeight) {
            // Assinatura/imagem de variável: cabe no placeholder mantendo proporção
            const s = Math.min(
              obj.targetWidth / source.width,
              obj.targetHeight / source.height,
            );
            const img = await this.prepareImage(source, s * scale);
            attach(obj, img);
            Object.assign(obj, {
              cropX: 0,
              cropY: 0,
              scaleX: (s * source.width) / img.width,
              scaleY: (s * source.height) / img.height,
            });
          } else {
            const cropped = obj.cropX || obj.cropY;
            const sameSize =
              Math.round(obj.width) === source.width &&
              Math.round(obj.height) === source.height;
            const factor =
              !cropped && sameSize && !nested
                ? Math.max(
                    Math.abs(obj.scaleX || 1),
                    Math.abs(obj.scaleY || 1),
                  ) * scale
                : 1;
            const img = await this.prepareImage(source, factor);
            const sx = ((obj.scaleX || 1) * source.width) / img.width;
            const sy = ((obj.scaleY || 1) * source.height) / img.height;
            const keep = { width: obj.width, height: obj.height };
            attach(obj, img);
            if (img.width === source.width) Object.assign(obj, keep);
            else Object.assign(obj, { scaleX: sx, scaleY: sy });
          }
        }
        if (Array.isArray(obj.objects))
          obj.objects = await walk(obj.objects, true);
        out.push(obj);
      }
      return out;
    };

    json.objects = await walk(json.objects || []);
    for (const prop of ['backgroundImage', 'overlayImage']) {
      const bg = json[prop];
      if (bg && typeof bg === 'object' && bg.src) {
        const source = await this.fetchImage(bg.src);
        if (!source) {
          delete json[prop];
          continue;
        }
        const keep = { width: bg.width, height: bg.height };
        attach(bg, await this.prepareImage(source, 1));
        Object.assign(bg, keep);
      }
    }
    return images;
  }

  /** Entrega os elementos decodificados às imagens marcadas em `resolveImages`. */
  private attachImages(
    fabric: ReturnType<typeof setupFabric>,
    canvas: any,
    images: Map<string, PreparedImage>,
  ) {
    const doc = fabric.getEnv().document;
    const visit = (obj: any) => {
      if (!obj) return;
      const img = obj.renderImageId && images.get(obj.renderImageId);
      if (img) {
        const decoded = new NodeImage();
        decoded.src = img.buffer;
        const el = doc.createElement('canvas');
        el.width = decoded.width;
        el.height = decoded.height;
        el.getContext('2d').drawImage(decoded as any, 0, 0);
        obj.setElement(el, { width: obj.width, height: obj.height });
      }
      if (typeof obj.getObjects === 'function') obj.getObjects().forEach(visit);
    };
    canvas.getObjects().forEach(visit);
    visit(canvas.backgroundImage);
    visit(canvas.overlayImage);
  }

  /** Download (com cache: as URLs do S3 levam timestamp e não mudam). */
  private async fetchImage(src: string): Promise<SourceImage | null> {
    const cached = this.sourceImages.get(src);
    if (cached) return cached;
    try {
      let input: Buffer;
      if (src.startsWith('data:')) {
        input = Buffer.from(src.split(',')[1] || '', 'base64');
      } else {
        // URLs antigas podem ter passado pelo proxy de imagens do front
        const proxied = src.match(/[?&]url=([^&]+)/);
        const url =
          proxied && src.includes('/images/proxy')
            ? decodeURIComponent(proxied[1])
            : src;
        const res = await fetch(url.replace(/^http:\/\//, 'https://'), {
          signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        input = Buffer.from(await res.arrayBuffer());
      }
      const meta = await sharp(input).metadata();
      const image: SourceImage = {
        buffer: input,
        width: meta.width,
        height: meta.height,
        // PNG com canal alfa mas todo opaco (fundos) pode virar JPEG
        hasAlpha: !!meta.hasAlpha && !(await sharp(input).stats()).isOpaque,
      };
      if (!src.startsWith('data:')) {
        this.sourceImages.set(src, image);
        this.sourceBytes += input.length;
        while (
          this.sourceBytes > SOURCE_CACHE_MAX_BYTES &&
          this.sourceImages.size > 1
        ) {
          const [oldKey, old] = this.sourceImages.entries().next().value as [
            string,
            SourceImage,
          ];
          this.sourceImages.delete(oldKey);
          this.sourceBytes -= old.buffer.length;
        }
      }
      return image;
    } catch (err) {
      this.logger.warn(
        `Imagem ignorada no render (${src.slice(0, 120)}): ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Reduz a imagem ao tamanho em que será desenhada (nunca amplia) e converte
   * para um formato que o canvas decodifica rápido: JPEG quando não há
   * transparência, PNG com compressão leve quando há (webp/svg viram PNG).
   */
  private async prepareImage(
    source: SourceImage,
    maxFactor: number,
  ): Promise<PreparedImage> {
    const factor = Math.min(1, maxFactor);
    const width = Math.max(1, Math.round(source.width * factor));
    const height = Math.max(1, Math.round(source.height * factor));
    let pipeline = sharp(source.buffer);
    if (width < source.width) pipeline = pipeline.resize(width, height);
    const buffer = source.hasAlpha
      ? await pipeline.png({ compressionLevel: 1 }).toBuffer()
      : await pipeline.jpeg({ quality: 92 }).toBuffer();
    return { buffer, width, height };
  }

  private async cached(key: string, produce: () => Promise<Buffer>) {
    const hit = this.cache.get(key);
    if (hit) {
      // LRU: reinsere no fim
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = produce()
      .then((buf) => {
        this.cache.set(key, buf);
        this.cacheBytes += buf.length;
        while (this.cacheBytes > CACHE_MAX_BYTES && this.cache.size > 1) {
          const [oldKey, oldBuf] = this.cache.entries().next().value as [
            string,
            Buffer,
          ];
          this.cache.delete(oldKey);
          this.cacheBytes -= oldBuf.length;
        }
        return buf;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /** No máximo N renders simultâneos (RAM do plano Hobby). */
  private async limit<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_CONCURRENT_RENDERS) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}

interface SourceImage {
  buffer: Buffer;
  width: number;
  height: number;
  hasAlpha: boolean;
}

interface PreparedImage {
  buffer: Buffer;
  width: number;
  height: number;
}

function parseJson(raw: unknown): any {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** Assinatura curta do destaque para compor a versão de cache. */
function highlightSignature(h: {
  kind: string;
  theme: string;
  label: string;
  pattern: string;
}) {
  return createHash('sha1')
    .update(`${h.kind}|${h.theme}|${h.label}|${h.pattern}`)
    .digest('hex')
    .slice(0, 8);
}

/**
 * Onde vai o selo, em px do canvas. Com marcador no modelo, o quadrado do
 * marcador (lado = menor medida); sem marcador, canto inferior esquerdo —
 * nos modelos atuais o QR costuma ficar à direita e as assinaturas no centro.
 */
function sealBox(
  marker: any,
  width: number,
  height: number,
  scale: number,
): SealBox {
  if (marker) {
    const w = (marker.width || 120) * (marker.scaleX || 1);
    const h = (marker.height || 120) * (marker.scaleY || 1);
    const size = Math.min(w, h);
    return {
      x: ((marker.left || 0) + (w - size) / 2) * scale,
      y: (marker.top || 0) * scale,
      size: size * scale,
    };
  }
  const landscape = width >= height;
  // selo pequeno e discreto: o quadrado é a altura do mosquetão
  const size = (landscape ? 0.125 : 0.16) * width;
  // margem conta com as molduras (que costumam ocupar 3–6% da borda)
  const marginX = 0.075 * width;
  const marginBottom = 0.1 * height;
  return {
    x: marginX * scale,
    y: (height - size * SEAL_HEIGHT_RATIO - marginBottom) * scale,
    size: size * scale,
  };
}

/**
 * Texto com `maxHeight` (definido no modelo): reduz a fonte até o texto
 * quebrado caber nessa altura — nomes, empresas e currículos longos não
 * invadem o que vem embaixo. Nunca abaixo de 55% do tamanho original.
 */
function fitTextToMaxHeight(obj: any) {
  const max = Number(obj.maxHeight);
  if (!max || !(obj.height > max)) return;
  const original = obj.fontSize;
  const floor = original * 0.55;
  while (obj.height > max && obj.fontSize > floor) {
    obj.set('fontSize', Math.max(floor, obj.fontSize - 0.5));
    obj.initDimensions();
  }
}

export type { CertificateVariables };
