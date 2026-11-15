import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import axios from 'axios';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import * as sharp from 'sharp';
import { UploadOptimizationService } from 'src/features/upload/upload-optimization.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { frontUrl } from '../mcp/mcp-oauth.service';

export interface StoredImage { id: number; url: string; name: string; width: number | null; height: number | null }

const MAX_BYTES = 20 * 1024 * 1024;
const LINK_MINUTES = 30;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Endereço privado/reservado: o download por URL nunca vai para a rede interna (SSRF). */
function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    return mapped ? privateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/**
 * Imagens que chegam pelos bots e pelo MCP: por link de envio (a pessoa
 * arrasta no WorkSafe), por URL pública ou em base64. Todas passam pela mesma
 * otimização do sistema (vários tamanhos no bucket público) e entram na
 * galeria de imagens da empresa.
 */
@Injectable()
export class ImageIntakeService {
  constructor(private readonly prisma: PrismaService, private readonly optimizer: UploadOptimizationService) {}

  /** A imagem é nossa (do bucket do sistema)? Só essas podem ir para post, turma etc. */
  static ownUrl(url: unknown): boolean {
    const value = String(url ?? '');
    const bucket = process.env.AWS_S3_BUCKET;
    if (process.env.PUBLIC_IMAGES_DRIVER === 'memory') return value.startsWith('https://imagens.teste.local/');
    return !!bucket && /^https:\/\//.test(value) && (value.startsWith(`https://${bucket}.s3.`) || value.startsWith(`https://s3.${process.env.AWS_REGION}.amazonaws.com/${bucket}/`));
  }

  async fromBuffer(ctx: { companyId: number }, buffer: Buffer, name: string, folder = 'ia-imagens'): Promise<StoredImage> {
    if (!buffer?.length) throw new BadRequestException('Imagem vazia');
    if (buffer.length > MAX_BYTES) throw new BadRequestException('Imagem maior que 20 MB');
    let meta: sharp.Metadata;
    try {
      meta = await sharp(buffer).metadata();
    } catch {
      throw new BadRequestException('O arquivo não é uma imagem válida');
    }
    if (!meta.format || !['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff'].includes(meta.format)) throw new BadRequestException('Formato de imagem não aceito (use JPG, PNG ou WEBP)');
    if ((meta.width ?? 0) < 16 || (meta.height ?? 0) < 16) throw new BadRequestException('Imagem pequena demais');
    const cleanName = String(name || 'imagem').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 120) || 'imagem';
    const url = process.env.PUBLIC_IMAGES_DRIVER === 'memory'
      ? `https://imagens.teste.local/${folder}/${randomUUID()}.webp`
      : (await this.optimizer.optimizeAndUploadImage(buffer, folder, cleanName)).mainUrl;
    const row = await this.prisma.image.create({
      data: { companyId: ctx.companyId, name: cleanName, imageUrl: url, type: 'general', width: meta.width ?? null, height: meta.height ?? null, fileSize: buffer.length, mimeType: `image/${meta.format}` },
    });
    return { id: row.id, url, name: cleanName, width: meta.width ?? null, height: meta.height ?? null };
  }

  /** Baixa uma imagem pública (https, sem rede interna, sem redirecionamento, até 20 MB). */
  async fromUrl(ctx: { companyId: number }, rawUrl: unknown, name?: string): Promise<StoredImage> {
    let url: URL;
    try {
      url = new URL(String(rawUrl ?? ''));
    } catch {
      throw new BadRequestException('URL inválida');
    }
    if (url.protocol !== 'https:') throw new BadRequestException('Só imagens em endereço https');
    if (url.username || url.password) throw new BadRequestException('URL inválida');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((item) => item.address);
    if (!addresses.length) throw new BadRequestException('Não consegui encontrar esse endereço');
    if (addresses.some(privateAddress)) throw new BadRequestException('Endereço não permitido');
    const response = await axios.get<ArrayBuffer>(url.toString(), {
      responseType: 'arraybuffer', timeout: 15000, maxRedirects: 0, maxContentLength: MAX_BYTES, validateStatus: () => true,
      headers: { 'User-Agent': 'WorkSafe-Imagens/1.0', Accept: 'image/*' },
    }).catch(() => null);
    if (!response || response.status !== 200) throw new BadRequestException(`Não consegui baixar a imagem${response ? ` (resposta ${response.status})` : ''}`);
    const type = String(response.headers['content-type'] ?? '');
    if (!type.startsWith('image/')) throw new BadRequestException('O endereço não é de uma imagem');
    return this.fromBuffer(ctx, Buffer.from(response.data), name || url.pathname.split('/').pop() || 'imagem');
  }

  async fromBase64(ctx: { companyId: number }, data: unknown, name?: string): Promise<StoredImage> {
    const value = String(data ?? '').replace(/^data:image\/[a-z+.-]+;base64,/i, '').replace(/\s+/g, '');
    if (!value || !/^[A-Za-z0-9+/]+=*$/.test(value)) throw new BadRequestException('Base64 inválido');
    if (value.length > Math.ceil((8 * 1024 * 1024 * 4) / 3)) throw new BadRequestException('Imagem em base64 maior que 8 MB: use o link de envio');
    return this.fromBuffer(ctx, Buffer.from(value, 'base64'), name || 'imagem');
  }

  // ---------------------------------------------------------------- link de envio

  async createLink(ctx: { userId: number; companyId: number }, purpose: unknown, maxFiles?: unknown) {
    const token = randomBytes(24).toString('base64url');
    const max = Math.min(20, Math.max(1, Number(maxFiles) || 10));
    const row = await this.prisma.ai_UploadLink.create({
      data: { companyId: ctx.companyId, userId: ctx.userId, tokenHash: hash(token), purpose: String(purpose ?? '').trim().slice(0, 200) || 'Imagens', maxFiles: max, expiresAt: new Date(Date.now() + LINK_MINUTES * 60000) },
    });
    return { id: row.id, url: `${frontUrl()}/enviar-imagens?t=${token}`, expiresAt: row.expiresAt, maxFiles: max };
  }

  private async byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) throw new NotFoundException('Link inválido');
    const row = await this.prisma.ai_UploadLink.findUnique({ where: { tokenHash: hash(token) } });
    if (!row) throw new NotFoundException('Link inválido');
    return row;
  }

  /** O que a página pública mostra. */
  async describeLink(token: string) {
    const row = await this.byToken(token);
    const company = await this.prisma.company.findUnique({ where: { id: row.companyId }, select: { comercial_name: true } });
    return {
      purpose: row.purpose, company: company?.comercial_name ?? null, expiresAt: row.expiresAt, expired: row.expiresAt <= new Date(),
      maxFiles: row.maxFiles, images: (row.images as unknown as StoredImage[]) ?? [],
    };
  }

  async addToLink(token: string, files: Array<{ buffer: Buffer; originalname: string; mimetype: string }>) {
    const row = await this.byToken(token);
    if (row.expiresAt <= new Date()) throw new BadRequestException('O link expirou. Peça um novo ao assistente.');
    const current = (row.images as unknown as StoredImage[]) ?? [];
    if (!files?.length) throw new BadRequestException('Escolha as imagens');
    if (current.length + files.length > row.maxFiles) throw new BadRequestException(`Este link aceita até ${row.maxFiles} imagens`);
    const added: StoredImage[] = [];
    for (const file of files) added.push(await this.fromBuffer({ companyId: row.companyId }, file.buffer, file.originalname));
    const images = [...current, ...added];
    await this.prisma.ai_UploadLink.update({ where: { id: row.id }, data: { images: images as unknown as Prisma.InputJsonValue } });
    return { images };
  }

  /** As imagens que a pessoa já subiu pelo link (para o assistente usar). */
  async linkImages(ctx: { userId: number; companyId: number }, id: number) {
    const row = await this.prisma.ai_UploadLink.findFirst({ where: { id, companyId: ctx.companyId, userId: ctx.userId } });
    if (!row) throw new NotFoundException('Envio não encontrado');
    return { envioId: row.id, finalidade: row.purpose, expirado: row.expiresAt <= new Date(), imagens: (row.images as unknown as StoredImage[]) ?? [] };
  }
}
