import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import axios, { AxiosError } from 'axios';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import * as sharp from 'sharp';
import { PrismaService } from 'src/prisma/prisma.service';
import { decryptPayload, encryptPayload } from 'src/utils/crypto';
import { ImageIntakeService } from '../images/image-intake.service';
import { apiUrl, frontUrl } from '../mcp/mcp-oauth.service';

/**
 * Instagram pela API oficial da Meta (Instagram Login): a empresa conecta a
 * conta profissional com um clique (tela de permissão da Meta), a chave de
 * 60 dias fica criptografada e é renovada sozinha, e os posts e stories
 * agendados são publicados por uma tarefa que roda a cada minuto.
 *
 * Fluxo da publicação (a Meta processa a mídia em segundo plano):
 * scheduled → (cria o contêiner) processing → (FINISHED) publica → published.
 */

export type PostKind = 'feed' | 'story' | 'carousel';
export const POST_KINDS: PostKind[] = ['feed', 'story', 'carousel'];
export const KIND_LABEL: Record<PostKind, string> = { feed: 'post no feed', story: 'story', carousel: 'carrossel' };
const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];
const STATE_MINUTES = 15;
const MAX_CAPTION = 2200;
const MAX_HASHTAGS = 30;
const MAX_DAYS_AHEAD = 75;
const PROCESSING_TIMEOUT_MIN = 15;

export interface InstagramActor { userId: number; companyId: number }

/** Erro da Meta com mensagem legível (e se a chave caiu). */
export class InstagramError extends Error {
  constructor(message: string, readonly tokenInvalid = false) { super(message); }
}

const appId = () => process.env.INSTAGRAM_APP_ID?.trim() || '';
const appSecret = () => process.env.INSTAGRAM_APP_SECRET?.trim() || '';
const graph = (path: string) => {
  const version = process.env.INSTAGRAM_GRAPH_VERSION?.trim();
  return `https://graph.instagram.com${version ? `/${version}` : ''}${path}`;
};
export const instagramRedirectUri = () => `${apiUrl()}/ai/connectors/instagram/callback`;
export const instagramConfigured = () => !!appId() && !!appSecret();

/** "2026-11-25T18:00" sem fuso = horário de Brasília. */
export function parseWhen(value: unknown): Date | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const withZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw.length === 10 ? `${raw}T09:00` : raw}-03:00`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date;
}

function metaMessage(error: unknown): { message: string; tokenInvalid: boolean } {
  const data = (error as AxiosError<any>)?.response?.data;
  const meta = data?.error ?? data;
  const code = Number(meta?.code);
  const text = String(meta?.error_user_msg || meta?.message || meta?.error_message || (error as Error)?.message || 'erro desconhecido');
  const tokenInvalid = code === 190 || meta?.type === 'OAuthException' && /token/i.test(text);
  return { message: text.slice(0, 500), tokenInvalid };
}

@Injectable()
export class InstagramService {
  private readonly logger = new Logger(InstagramService.name);
  private s3?: S3Client;
  /** Pausa entre as checagens do "publicar agora" (zerada nos testes). */
  waitMs = 2500;

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- conexão

  private sign(body: string) {
    return createHmac('sha256', process.env.PAYLOAD_ACCESS_SECRET || 'instagram-state').update(body).digest('base64url');
  }

  /** Endereço da tela de permissão da Meta, com um state assinado (empresa, pessoa, validade). */
  startUrl(actor: InstagramActor) {
    if (!instagramConfigured()) throw new BadRequestException('O app da Meta ainda não foi cadastrado neste servidor. Peça para quem administra o sistema seguir o passo a passo de cadastro.');
    const body = Buffer.from(JSON.stringify({ c: actor.companyId, u: actor.userId, e: Date.now() + STATE_MINUTES * 60000, n: randomBytes(8).toString('hex') })).toString('base64url');
    const state = `${body}.${this.sign(body)}`;
    const params = new URLSearchParams({ client_id: appId(), redirect_uri: instagramRedirectUri(), response_type: 'code', scope: SCOPES.join(','), state, enable_fb_login: 'false', force_reauth: 'true' });
    return { url: `https://www.instagram.com/oauth/authorize?${params.toString()}` };
  }

  private readState(state: unknown): InstagramActor {
    const [body, signature] = String(state ?? '').split('.');
    if (!body || !signature) throw new InstagramError('Pedido de conexão inválido. Tente conectar de novo.');
    const expected = Buffer.from(this.sign(body));
    const got = Buffer.from(signature);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new InstagramError('Pedido de conexão inválido. Tente conectar de novo.');
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data?.c || Number(data.e) < Date.now()) throw new InstagramError('O pedido de conexão expirou. Tente conectar de novo.');
    return { companyId: Number(data.c), userId: Number(data.u) || 0 };
  }

  /** Volta da Meta: troca o código pela chave de 60 dias e guarda a conta. Devolve para onde mandar a pessoa. */
  async callback(query: Record<string, unknown>): Promise<string> {
    const back = (params: Record<string, string>) => `${frontUrl()}/bots/conectores?${new URLSearchParams(params).toString()}`;
    try {
      if (query.error) {
        const denied = query.error === 'access_denied';
        return back({ instagram: 'erro', motivo: denied ? 'Você cancelou a conexão na tela da Meta.' : String(query.error_description || query.error).slice(0, 200) });
      }
      const actor = this.readState(query.state);
      const code = String(query.code ?? '').replace(/#_$/, '');
      if (!code) throw new InstagramError('A Meta não devolveu o código de acesso. Tente de novo.');
      if (!instagramConfigured()) throw new InstagramError('O app da Meta não está configurado neste servidor.');

      const form = new URLSearchParams({ client_id: appId(), client_secret: appSecret(), grant_type: 'authorization_code', redirect_uri: instagramRedirectUri(), code });
      const short = await axios.post('https://api.instagram.com/oauth/access_token', form.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
      const shortData = Array.isArray(short.data?.data) ? short.data.data[0] : short.data;
      const permissions = String(shortData?.permissions ?? '');
      if (permissions && !permissions.includes('instagram_business_content_publish')) {
        throw new InstagramError('A permissão de publicar não foi concedida. Conecte de novo e deixe marcada a opção de publicar conteúdo.');
      }
      const long = await axios.get(graph('/access_token'), { params: { grant_type: 'ig_exchange_token', client_secret: appSecret(), access_token: shortData?.access_token }, timeout: 15000 });
      const token = String(long.data?.access_token ?? '');
      if (!token) throw new InstagramError('A Meta não devolveu a chave de acesso.');
      const me = await axios.get(graph('/me'), { params: { fields: 'user_id,username,name,profile_picture_url,account_type', access_token: token }, timeout: 15000 });
      const profile = me.data ?? {};
      const accountType = String(profile.account_type ?? '');
      if (accountType && !['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(accountType.toUpperCase())) {
        throw new InstagramError('Essa conta do Instagram é pessoal. Mude para conta profissional (Empresa ou Criador de conteúdo) no app do Instagram e conecte de novo.');
      }
      const data = {
        accountId: String(profile.user_id ?? profile.id ?? shortData?.user_id ?? ''),
        username: profile.username ? String(profile.username) : null,
        name: profile.name ? String(profile.name) : null,
        pictureUrl: profile.profile_picture_url ? String(profile.profile_picture_url) : null,
        accountType: accountType || null,
        tokenEncrypted: encryptPayload(token),
        tokenExpiresAt: new Date(Date.now() + (Number(long.data?.expires_in) || 60 * 86400) * 1000),
        refreshedAt: new Date(),
        status: 'connected',
        lastError: null,
        connectedByUserId: actor.userId || null,
      };
      await this.prisma.ai_Connector.upsert({
        where: { companyId_provider: { companyId: actor.companyId, provider: 'instagram' } },
        create: { companyId: actor.companyId, provider: 'instagram', ...data },
        update: data,
      });
      return back({ instagram: 'ok' });
    } catch (error) {
      const message = error instanceof InstagramError ? error.message : `A Meta recusou a conexão: ${metaMessage(error).message}`;
      this.logger.warn(`Conexão com o Instagram falhou: ${message}`);
      return back({ instagram: 'erro', motivo: message.slice(0, 300) });
    }
  }

  /** O que a tela e os bots veem da conexão (nunca a chave). */
  async status(companyId: number) {
    const row = await this.prisma.ai_Connector.findUnique({ where: { companyId_provider: { companyId, provider: 'instagram' } } });
    const expired = !!row && (row.status === 'expired' || (row.tokenExpiresAt && row.tokenExpiresAt < new Date()));
    return {
      configured: instagramConfigured(),
      redirectUri: instagramRedirectUri(),
      account: row ? {
        username: row.username, name: row.name, pictureUrl: row.pictureUrl, accountType: row.accountType,
        connectedAt: row.createdAt, refreshedAt: row.refreshedAt, expiresAt: row.tokenExpiresAt,
        status: expired ? 'expired' : 'connected', lastError: row.lastError, connectedByUserId: row.connectedByUserId,
      } : null,
    };
  }

  async disconnect(companyId: number) {
    await this.prisma.ai_Connector.deleteMany({ where: { companyId, provider: 'instagram' } });
    await this.prisma.ai_SocialPost.updateMany({ where: { companyId, status: 'scheduled' }, data: { status: 'canceled', error: 'Instagram desconectado' } });
    return { ok: true };
  }

  private async connection(companyId: number) {
    const row = await this.prisma.ai_Connector.findUnique({ where: { companyId_provider: { companyId, provider: 'instagram' } } });
    if (!row) throw new InstagramError('O Instagram não está conectado. Conecte em Bots → Conectores.');
    if (row.status === 'expired' || (row.tokenExpiresAt && row.tokenExpiresAt < new Date())) throw new InstagramError('A conexão com o Instagram expirou. Conecte de novo em Bots → Conectores.', true);
    return { row, token: String(decryptPayload(row.tokenEncrypted)) };
  }

  private async markExpired(companyId: number, message: string) {
    await this.prisma.ai_Connector.updateMany({ where: { companyId, provider: 'instagram' }, data: { status: 'expired', lastError: message } });
  }

  /** Renova as chaves com mais de 7 dias (a Meta só renova chave com 24 h ou mais e ainda válida). */
  async refreshTokens() {
    const rows = await this.prisma.ai_Connector.findMany({ where: { provider: 'instagram', status: 'connected', refreshedAt: { lt: new Date(Date.now() - 7 * 86400000) } } });
    for (const row of rows) {
      try {
        if (row.tokenExpiresAt && row.tokenExpiresAt < new Date()) { await this.markExpired(row.companyId, 'A chave expirou antes de ser renovada'); continue; }
        const out = await axios.get(graph('/refresh_access_token'), { params: { grant_type: 'ig_refresh_token', access_token: String(decryptPayload(row.tokenEncrypted)) }, timeout: 15000 });
        await this.prisma.ai_Connector.update({
          where: { id: row.id },
          data: { tokenEncrypted: encryptPayload(String(out.data.access_token)), tokenExpiresAt: new Date(Date.now() + (Number(out.data.expires_in) || 60 * 86400) * 1000), refreshedAt: new Date(), lastError: null },
        });
      } catch (error) {
        const meta = metaMessage(error);
        if (meta.tokenInvalid) await this.markExpired(row.companyId, meta.message);
        else await this.prisma.ai_Connector.update({ where: { id: row.id }, data: { lastError: `Renovação falhou: ${meta.message}` } });
      }
    }
    return rows.length;
  }

  // ---------------------------------------------------------------- posts

  /** Valida e grava um post agendado (vale para a tela e para a Nina). */
  async validate(companyId: number, input: { kind?: unknown; caption?: unknown; media?: unknown; scheduledAt?: unknown }) {
    const kind = String(input.kind ?? '') as PostKind;
    if (!POST_KINDS.includes(kind)) throw new BadRequestException('Tipo inválido: use post no feed, story ou carrossel');
    const media = (Array.isArray(input.media) ? input.media : [input.media]).map((url) => String(url ?? '').trim()).filter(Boolean);
    if (!media.length) throw new BadRequestException('Escolha a imagem do post');
    if (kind === 'carousel' && (media.length < 2 || media.length > 10)) throw new BadRequestException('O carrossel precisa de 2 a 10 imagens');
    if (kind !== 'carousel' && media.length > 1) throw new BadRequestException(`O ${KIND_LABEL[kind]} leva uma imagem só (para várias, use carrossel)`);
    if (media.some((url) => !ImageIntakeService.ownUrl(url))) throw new BadRequestException('Use imagens que já estejam no WorkSafe');
    const caption = kind === 'story' ? '' : String(input.caption ?? '').trim();
    if (caption.length > MAX_CAPTION) throw new BadRequestException(`A legenda passa de ${MAX_CAPTION} caracteres`);
    if ((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > MAX_HASHTAGS) throw new BadRequestException(`O Instagram aceita no máximo ${MAX_HASHTAGS} hashtags`);
    const when = input.scheduledAt ? parseWhen(input.scheduledAt) : new Date();
    if (!when) throw new BadRequestException('Data e hora inválidas');
    if (when.getTime() < Date.now() - 5 * 60000) throw new BadRequestException('Esse horário já passou');
    if (when.getTime() > Date.now() + MAX_DAYS_AHEAD * 86400000) throw new BadRequestException(`Dá para agendar até ${MAX_DAYS_AHEAD} dias à frente`);
    const connected = await this.prisma.ai_Connector.findUnique({ where: { companyId_provider: { companyId, provider: 'instagram' } } });
    if (!connected) throw new BadRequestException('O Instagram não está conectado. Conecte em Bots → Conectores.');
    return { kind, caption, media, scheduledAt: when };
  }

  async create(actor: InstagramActor, input: Record<string, unknown>, botId?: number | null) {
    const data = await this.validate(actor.companyId, input);
    const post = await this.prisma.ai_SocialPost.create({ data: { companyId: actor.companyId, ...data, media: data.media, botId: botId ?? null, createdByUserId: actor.userId || null } });
    return this.present(post);
  }

  async list(companyId: number, filter: { status?: string } = {}) {
    const where: Record<string, unknown> = { companyId };
    if (filter.status === 'upcoming') where.status = { in: ['scheduled', 'processing'] };
    else if (filter.status && ['published', 'failed', 'canceled'].includes(filter.status)) where.status = filter.status;
    const rows = await this.prisma.ai_SocialPost.findMany({ where, orderBy: [{ scheduledAt: filter.status === 'upcoming' ? 'asc' : 'desc' }], take: 100 });
    return rows.map((row) => this.present(row));
  }

  present(row: { id: number; kind: string; caption: string; media: unknown; scheduledAt: Date; status: string; permalink: string | null; error: string | null; botId: number | null; createdByUserId: number | null; publishedAt: Date | null; createdAt: Date }) {
    return { id: row.id, kind: row.kind, caption: row.caption, media: (row.media as string[]) ?? [], scheduledAt: row.scheduledAt, status: row.status, permalink: row.permalink, error: row.error, botId: row.botId, createdByUserId: row.createdByUserId, publishedAt: row.publishedAt, createdAt: row.createdAt };
  }

  async cancel(companyId: number, id: number) {
    const done = await this.prisma.ai_SocialPost.updateMany({ where: { id, companyId, status: 'scheduled' }, data: { status: 'canceled' } });
    if (!done.count) {
      const post = await this.prisma.ai_SocialPost.findFirst({ where: { id, companyId } });
      if (!post) throw new NotFoundException('Post não encontrado');
      throw new BadRequestException(post.status === 'published' ? 'Esse post já foi publicado (para tirar do ar, apague no Instagram)' : 'Só dá para cancelar post que ainda está agendado');
    }
    return { ok: true };
  }

  /** Publica agora: adianta o horário e já tenta concluir (a Meta costuma processar imagem em segundos). */
  async publishNow(companyId: number, id: number) {
    const post = await this.prisma.ai_SocialPost.findFirst({ where: { id, companyId } });
    if (!post) throw new NotFoundException('Post não encontrado');
    if (!['scheduled', 'failed'].includes(post.status)) throw new BadRequestException(post.status === 'published' ? 'Esse post já foi publicado' : 'Esse post não pode ser publicado agora');
    await this.prisma.ai_SocialPost.update({ where: { id }, data: { status: 'scheduled', scheduledAt: new Date(), error: null, containerId: null } });
    await this.runPost(id);
    for (let i = 0; i < 4; i++) {
      const current = await this.prisma.ai_SocialPost.findUnique({ where: { id } });
      if (current?.status !== 'processing') break;
      if (this.waitMs) await new Promise((resolve) => setTimeout(resolve, this.waitMs));
      await this.checkPost(id);
    }
    const final = await this.prisma.ai_SocialPost.findUnique({ where: { id } });
    return this.present(final!);
  }

  // ---------------------------------------------------------------- publicação

  @Cron('30 * * * * *')
  async tick() {
    if (process.env.NODE_ENV === 'test' || process.env.INSTAGRAM_PUBLISH_ENABLED === 'false') return;
    await this.runDue().catch((error) => this.logger.error(`Publicação do Instagram falhou: ${error?.message}`));
  }

  @Cron('0 15 3 * * *')
  async refreshTick() {
    if (process.env.NODE_ENV === 'test') return;
    await this.refreshTokens().catch((error) => this.logger.error(`Renovação do Instagram falhou: ${error?.message}`));
  }

  /** Publica o que venceu e confere o que está em processamento na Meta. */
  async runDue() {
    const due = await this.prisma.ai_SocialPost.findMany({ where: { status: 'scheduled', scheduledAt: { lte: new Date() } }, orderBy: { scheduledAt: 'asc' }, take: 10, select: { id: true } });
    for (const post of due) await this.runPost(post.id);
    const processing = await this.prisma.ai_SocialPost.findMany({ where: { status: 'processing', containerId: { not: null } }, take: 20, select: { id: true } });
    for (const post of processing) await this.checkPost(post.id);
    return { started: due.length, checked: processing.length };
  }

  private async fail(post: { id: number; companyId: number }, error: unknown) {
    const meta = error instanceof InstagramError ? { message: error.message, tokenInvalid: error.tokenInvalid } : metaMessage(error);
    if (meta.tokenInvalid) await this.markExpired(post.companyId, meta.message);
    await this.prisma.ai_SocialPost.update({ where: { id: post.id }, data: { status: 'failed', error: meta.tokenInvalid ? 'A conexão com o Instagram expirou. Conecte de novo em Bots → Conectores e publique outra vez.' : meta.message } });
  }

  /** Reivindica o post (uma instância só) e cria o contêiner na Meta. */
  private async runPost(id: number) {
    const claimed = await this.prisma.ai_SocialPost.updateMany({ where: { id, status: 'scheduled' }, data: { status: 'processing', attempts: { increment: 1 } } });
    if (!claimed.count) return;
    const post = (await this.prisma.ai_SocialPost.findUnique({ where: { id } }))!;
    try {
      const { row, token } = await this.connection(post.companyId);
      const media = (post.media as string[]) ?? [];
      const kind = post.kind as PostKind;
      const jpegs: string[] = [];
      let ratio: number | undefined;
      for (const url of media) {
        const out = await this.toJpeg(url, kind, ratio);
        ratio = ratio ?? out.ratio;
        jpegs.push(out.url);
      }
      const create = async (params: Record<string, string>) => {
        const res = await axios.post(graph(`/${row.accountId}/media`), null, { params: { ...params, access_token: token }, timeout: 30000 });
        return String(res.data.id);
      };
      let containerId: string;
      if (kind === 'story') containerId = await create({ media_type: 'STORIES', image_url: jpegs[0] });
      else if (kind === 'carousel') {
        const children: string[] = [];
        for (const url of jpegs) children.push(await create({ image_url: url, is_carousel_item: 'true' }));
        containerId = await create({ media_type: 'CAROUSEL', children: children.join(','), caption: post.caption });
      } else containerId = await create({ image_url: jpegs[0], caption: post.caption });
      await this.prisma.ai_SocialPost.update({ where: { id }, data: { containerId } });
      await this.checkPost(id);
    } catch (error) {
      await this.fail(post, error);
    }
  }

  /** Contêiner pronto? Publica e guarda o link do post. */
  private async checkPost(id: number) {
    const post = await this.prisma.ai_SocialPost.findUnique({ where: { id } });
    if (!post || post.status !== 'processing' || !post.containerId) return;
    try {
      const { row, token } = await this.connection(post.companyId);
      const status = await axios.get(graph(`/${post.containerId}`), { params: { fields: 'status_code,status', access_token: token }, timeout: 15000 });
      const code = String(status.data?.status_code ?? '');
      if (code === 'IN_PROGRESS') {
        if (Date.now() - post.updatedAt.getTime() > PROCESSING_TIMEOUT_MIN * 60000) throw new InstagramError('A Meta não terminou de processar a imagem a tempo. Tente publicar de novo.');
        return;
      }
      if (code === 'ERROR' || code === 'EXPIRED') throw new InstagramError(`A Meta não aceitou a mídia (${code === 'EXPIRED' ? 'expirou' : String(status.data?.status ?? 'erro no processamento')}).`);
      const published = await axios.post(graph(`/${row.accountId}/media_publish`), null, { params: { creation_id: post.containerId, access_token: token }, timeout: 30000 });
      const mediaId = String(published.data.id);
      let permalink: string | null = null;
      try {
        const info = await axios.get(graph(`/${mediaId}`), { params: { fields: 'permalink', access_token: token }, timeout: 15000 });
        permalink = info.data?.permalink ? String(info.data.permalink) : null;
      } catch { /* o link é só conveniência */ }
      await this.prisma.ai_SocialPost.update({ where: { id }, data: { status: 'published', externalId: mediaId, permalink, publishedAt: new Date(), error: null } });
    } catch (error) {
      await this.fail(post, error);
    }
  }

  // ---------------------------------------------------------------- imagens

  /**
   * A Meta só aceita JPEG num endereço público. Converte, ajusta a proporção
   * (feed entre 4:5 e 1,91:1; story 9:16; carrossel na proporção da primeira)
   * e sobe no bucket.
   */
  async toJpeg(url: string, kind: PostKind, forcedRatio?: number): Promise<{ url: string; ratio: number }> {
    if (!ImageIntakeService.ownUrl(url)) throw new InstagramError('Imagem fora do WorkSafe');
    const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 25 * 1024 * 1024 }).catch(() => null);
    if (!res || res.status !== 200) throw new InstagramError('Não consegui abrir a imagem do post');
    let rotated: Buffer;
    try { rotated = await sharp(Buffer.from(res.data)).rotate().toBuffer(); } catch { throw new InstagramError('A imagem do post está corrompida'); }
    const image = sharp(rotated);
    const meta = await image.metadata();
    const width = meta.width || 1080;
    const height = meta.height || 1080;
    const original = width / height;
    const ratio = kind === 'story' ? 9 / 16 : forcedRatio ?? Math.min(1.91, Math.max(0.8, original));
    const targetWidth = kind === 'story' ? 1080 : Math.min(1440, Math.max(1080, width));
    const targetHeight = Math.round(targetWidth / ratio);
    const buffer = await image.resize(targetWidth, targetHeight, { fit: 'cover', position: 'attention' }).flatten({ background: '#ffffff' }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    return { url: await this.store(buffer), ratio };
  }

  /** Imagem que a pessoa sobe na tela de posts: vira JPEG já no upload. */
  async upload(buffer: Buffer): Promise<{ url: string }> {
    if (!buffer?.length) throw new BadRequestException('Imagem vazia');
    let meta: sharp.Metadata;
    try { meta = await sharp(buffer).metadata(); } catch { throw new BadRequestException('O arquivo não é uma imagem válida'); }
    if (!meta.format || !['jpeg', 'png', 'webp', 'heif', 'avif'].includes(meta.format)) throw new BadRequestException('Use imagem JPG, PNG ou WEBP');
    const jpeg = await sharp(buffer).rotate().resize({ width: 2160, height: 2160, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    return { url: await this.store(jpeg) };
  }

  private async store(buffer: Buffer): Promise<string> {
    const key = `instagram/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.jpg`;
    if (process.env.PUBLIC_IMAGES_DRIVER === 'memory') return `https://imagens.teste.local/${key}`;
    const bucket = process.env.AWS_S3_BUCKET as string;
    this.s3 ??= new S3Client({ region: process.env.AWS_REGION, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID as string, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string } });
    await this.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000, immutable' }));
    return `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
  }
}
