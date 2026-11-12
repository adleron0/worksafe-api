import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Image as NodeImage } from 'canvas';
import * as sharp from 'sharp';
import * as QRCode from 'qrcode';
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
export const RENDER_VERSION = 1;

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
        fabricJsonFront: true,
        fabricJsonBack: true,
        canvasWidth: true,
        canvasHeight: true,
        variableToReplace: true,
        trainee: { select: { name: true } },
        course: { select: { name: true } },
      },
    });
    if (!cert) throw new NotFoundException('Certificado não encontrado');
    return cert;
  }

  /** Versão para compor URLs cacheáveis (`?v=`). */
  version(cert: { updatedAt: Date | string }) {
    return `${new Date(cert.updatedAt).getTime()}-${RENDER_VERSION}`;
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
  async renderPng(
    cert: CertificateRecord,
    side: CertificateSide = 'front',
    scale = 2,
  ): Promise<Buffer> {
    if (side === 'back' && !this.hasBack(cert)) {
      throw new NotFoundException('Certificado sem verso');
    }
    return this.cached(
      `${this.version(cert)}:${cert.key}:${side}:${scale}`,
      () => this.limit(() => this.renderSide(cert, side, scale)),
    );
  }

  /** Miniatura JPEG da frente (listagens). */
  async renderThumb(cert: CertificateRecord): Promise<Buffer> {
    return this.cached(`${this.version(cert)}:${cert.key}:thumb`, async () => {
      const png = await this.renderPng(cert, 'front', 1);
      return sharp(png).jpeg({ quality: 82 }).toBuffer();
    });
  }

  /** PDF com frente (e verso, se houver), uma página A4 por lado. */
  async renderPdf(cert: CertificateRecord): Promise<Buffer> {
    return this.cached(`${this.version(cert)}:${cert.key}:pdf`, async () => {
      const sides: CertificateSide[] = this.hasBack(cert)
        ? ['front', 'back']
        : ['front'];
      const { width, height } = getLogicalCanvasSize(
        cert.canvasWidth,
        cert.canvasHeight,
      );
      const pages: Buffer[] = [];
      for (const side of sides) {
        const png = await this.renderPng(cert, side, 3);
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
  ): Promise<Buffer> {
    const started = Date.now();
    const fabric = setupFabric();
    const raw = parseJson(
      side === 'front' ? cert.fabricJsonFront : cert.fabricJsonBack,
    );
    if (!raw) throw new NotFoundException('Certificado sem desenho');

    const variables = parseCertificateVariables(cert.variableToReplace);
    const json = replaceInCanvasJSON(raw, variables);
    const images = await this.resolveImages(json, cert.key, scale);
    const tImages = Date.now();

    const { width, height } = getLogicalCanvasSize(
      cert.canvasWidth,
      cert.canvasHeight,
    );
    json.objects = json.objects || [];
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
        if (isTextboxType(obj.type) && obj.width > 0) obj.initDimensions();
      }
      const tLoad = Date.now();
      canvas.renderAll();
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
  private async resolveImages(json: any, key: string, scale: number) {
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

    let qr: Promise<Buffer> | null = null;
    const qrPng = () =>
      (qr ??= QRCode.toBuffer(`${FRONT_URL}/certificados/${key}`, {
        width: 200,
        margin: 1,
        errorCorrectionLevel: 'H',
        color: { dark: '#000000', light: '#FFFFFF' },
      }));

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
            scaleX: w / 200,
            scaleY: h / 200,
            angle: obj.angle || 0,
            name: `qrcode_${obj.qrCodeName}`,
          };
          attach(qrObj, { buffer: await qrPng(), width: 200, height: 200 });
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

export type { CertificateVariables };
