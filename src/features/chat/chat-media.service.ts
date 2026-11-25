import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { randomBytes } from 'crypto';
import { PrivateStorageService } from 'src/common/storage/private-storage.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatEventsService } from './chat-events.service';
import { EvolutionProvider } from './providers/evolution.provider';

/**
 * Fotos, áudios, vídeos e documentos das conversas.
 *
 * Tudo fica no armazenamento privado (S3 sem leitura pública). O link do
 * WhatsApp/Instagram expira ou vem criptografado, então a mídia recebida é
 * baixada em segundo plano logo que chega. A tela recebe um link assinado que
 * vale ~1 h (assinado pela hora cheia: o mesmo link durante a hora, sem a
 * imagem piscar a cada atualização).
 */

export const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'];
/** Recebida: acima disso fica só o aviso (não baixa). */
const MAX_IN = 30 * 1024 * 1024;
/** Enviada: limite do WhatsApp para mídia (documento vai até 100 MB, mas seguramos em 16). */
export const MAX_OUT = 16 * 1024 * 1024;
const LINK_SECONDS = 7200;

export interface ChatMedia {
  key?: string | null;
  mimetype?: string | null;
  fileName?: string | null;
  size?: number | null;
  seconds?: number | null;
  ptt?: boolean;
  /** pending (baixando) | ok | failed | too_big */
  /** só do WhatsApp: a mensagem original (com a chave da mídia) até baixar */
  raw?: { key: Record<string, unknown>; message?: Record<string, unknown> } | null;
  state?: string;
  /** só do Instagram: link original (expira) até baixar */
  sourceUrl?: string | null;
  [extra: string]: unknown;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/aac': 'aac', 'application/pdf': 'pdf',
};
const extOf = (mime: string | null | undefined, fileName?: string | null) => {
  const fromName = fileName?.match(/\.([a-z0-9]{1,8})$/i)?.[1];
  if (fromName) return fromName.toLowerCase();
  const base = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return EXT[base] ?? 'bin';
};

/** Qual tipo de mensagem um arquivo vira. */
export function typeOfFile(mime: string, ptt = false): 'image' | 'video' | 'audio' | 'document' {
  const base = mime.split(';')[0].trim().toLowerCase();
  if (ptt || base.startsWith('audio/')) return 'audio';
  if (['image/jpeg', 'image/png', 'image/webp'].includes(base)) return 'image';
  if (['video/mp4', 'video/3gpp'].includes(base)) return 'video';
  return 'document';
}

@Injectable()
export class ChatMediaService {
  private readonly logger = new Logger(ChatMediaService.name);
  private readonly tasks = new Set<Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: PrivateStorageService,
    private readonly provider: EvolutionProvider,
    private readonly events: ChatEventsService,
  ) {}

  /** Para os testes: espera os downloads em andamento. */
  async idle() {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }

  private track(work: Promise<unknown>) {
    const task = work.catch((error) => this.logger.warn(`Mídia: ${error?.message}`)).finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  private keyFor(companyId: number, conversationId: number, mime: string | null | undefined, fileName?: string | null) {
    return `chat/${companyId}/${conversationId}/${Date.now()}-${randomBytes(6).toString('hex')}.${extOf(mime, fileName)}`;
  }

  async save(companyId: number, conversationId: number, body: Buffer, mime: string, fileName?: string | null) {
    const key = this.keyFor(companyId, conversationId, mime, fileName);
    await this.storage.put(key, body, mime || 'application/octet-stream');
    return key;
  }

  /** Apaga do armazenamento (contato oculto). Arquivo que já não existe não é erro. */
  async remove(keys: string[]) {
    await Promise.all(keys.map((key) => this.storage.delete(key).catch(() => undefined)));
  }

  async read(key: string) {
    return this.storage.get(key);
  }

  /** Link assinado para a tela (estável durante a hora). */
  async link(media: ChatMedia | null | undefined): Promise<string | null> {
    if (!media?.key) return null;
    const hour = new Date();
    hour.setMinutes(0, 0, 0);
    return this.storage
      .linkTo(media.key, { fileName: media.fileName || media.key.split('/').pop()!, contentType: media.mimetype || 'application/octet-stream', inline: true, seconds: LINK_SECONDS, signingDate: hour })
      .catch(() => null);
  }

  /** Link público temporário (o Instagram baixa o arquivo pelo endereço). */
  async publicLink(media: ChatMedia, seconds = 3600) {
    return this.storage.linkTo(media.key!, { fileName: media.fileName || 'arquivo', contentType: media.mimetype || 'application/octet-stream', inline: true, seconds });
  }

  // ---------------------------------------------------------------- recebidas

  /** WhatsApp: baixa pelo Evolution em segundo plano. */
  fetchWhatsApp(messageId: number) {
    this.track(this.run(messageId, async (message, channel) => {
      if (!channel.instanceName || !message.externalId) throw new Error('sem conexão');
      const raw = (message.media as ChatMedia | null)?.raw;
      const got = await this.provider.mediaBase64(channel.instanceName, raw?.key ? raw : { key: { id: message.externalId } });
      if (!got) throw new Error('o WhatsApp não entregou a mídia');
      return { body: Buffer.from(got.base64, 'base64'), mimetype: got.mimetype, fileName: got.fileName };
    }));
  }

  /** Instagram: baixa o link da Meta (expira em poucas horas). */
  fetchUrl(messageId: number) {
    this.track(this.run(messageId, async (message) => {
      const url = (message.media as ChatMedia | null)?.sourceUrl;
      if (!url) throw new Error('sem endereço');
      const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: MAX_IN });
      return { body: Buffer.from(res.data), mimetype: String(res.headers['content-type'] ?? '') || null, fileName: null };
    }));
  }

  private async run(messageId: number, download: (message: any, channel: any) => Promise<{ body: Buffer; mimetype: string | null; fileName: string | null }>) {
    const message = await this.prisma.chat_Message.findUnique({ where: { id: messageId }, include: { conversation: { include: { channel: true } } } });
    if (!message) return;
    const media = (message.media as ChatMedia | null) ?? {};
    let next: ChatMedia;
    try {
      const got = await download(message, message.conversation.channel);
      if (got.body.length > MAX_IN) {
        next = { ...media, state: 'too_big', size: got.body.length };
      } else {
        const mimetype = (got.mimetype || media.mimetype || 'application/octet-stream').split(';')[0].trim();
        const fileName = media.fileName || got.fileName || null;
        const key = await this.save(message.companyId, message.conversationId, got.body, mimetype, fileName);
        next = { ...media, key, mimetype, fileName, size: got.body.length, state: 'ok', sourceUrl: null, raw: null };
      }
    } catch (error) {
      this.logger.warn(`Mídia da mensagem ${messageId} não baixou: ${(error as Error).message}`);
      next = { ...media, state: 'failed' };
    }
    await this.prisma.chat_Message.update({ where: { id: messageId }, data: { media: next as any } });
    this.events.emit({ companyId: message.companyId, kind: 'message', channelId: message.channelId, conversationId: message.conversationId, assignedUserId: message.conversation.assignedUserId });
  }

  /** "Tentar de novo" na tela, para mídia que não baixou. */
  async retry(message: { id: number; media: unknown; channelId: number }, channelType: string) {
    const media = (message.media as ChatMedia | null) ?? {};
    if (media.key) return;
    await this.prisma.chat_Message.update({ where: { id: message.id }, data: { media: { ...media, state: 'pending' } as any } });
    if (channelType === 'instagram') this.fetchUrl(message.id);
    else this.fetchWhatsApp(message.id);
  }

  // ---------------------------------------------------------------- enviadas

  /** Confere e guarda o arquivo que a pessoa anexou. */
  async upload(companyId: number, conversationId: number, file: { buffer: Buffer; mimetype: string; originalname?: string; size: number } | undefined, ptt: boolean): Promise<{ type: string; media: ChatMedia }> {
    if (!file?.buffer?.length) throw new BadRequestException('Escolha um arquivo.');
    if (file.size > MAX_OUT) throw new BadRequestException('O arquivo passa de 16 MB, o limite do WhatsApp. Mande um link ou um arquivo menor.');
    const mimetype = (file.mimetype || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    const type = typeOfFile(mimetype, ptt);
    const fileName = file.originalname ? Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 200) : null;
    const key = await this.save(companyId, conversationId, file.buffer, mimetype, fileName);
    return { type, media: { key, mimetype, fileName: type === 'document' ? fileName : fileName, size: file.size, ptt: type === 'audio' ? ptt : undefined, state: 'ok' } };
  }
}
