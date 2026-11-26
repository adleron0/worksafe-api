import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { PrismaService } from 'src/prisma/prisma.service';
import { ProviderKeyStore } from 'src/features/ai/providers/provider-keys.service';
import { ChatEventsService } from './chat-events.service';
import { ChatMedia, ChatMediaService } from './chat-media.service';
import { chatHooks } from './chat.hooks';
import { normalizeSettings } from './chat.settings';

const MAX_AUDIO = 24 * 1024 * 1024;

/** Quem transcreve: Groq (Whisper, quase de graça) e, sem a chave dela, a OpenAI. */
const ENGINES = [
  { provider: 'groq', url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: () => process.env.CHAT_TRANSCRIBE_GROQ_MODEL || 'whisper-large-v3-turbo' },
  { provider: 'openai', url: () => `${(process.env.AI_OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')}/audio/transcriptions`, model: () => process.env.CHAT_TRANSCRIBE_OPENAI_MODEL || 'whisper-1' },
] as const;

/**
 * Áudio do cliente vira texto: aparece embaixo do player, entra na busca do
 * bot e no resumo da conversa. Roda em segundo plano depois que o arquivo é
 * baixado; também dá para pedir na hora (áudios antigos).
 */
@Injectable()
export class ChatTranscribeService implements OnModuleInit {
  private readonly logger = new Logger(ChatTranscribeService.name);
  private readonly tasks = new Set<Promise<unknown>>();

  constructor(private readonly prisma: PrismaService, private readonly keys: ProviderKeyStore, private readonly media: ChatMediaService, private readonly events: ChatEventsService) {}

  onModuleInit() {
    chatHooks.audioReady = (messageId: number) => this.auto(messageId);
  }

  /** Para os testes: espera as transcrições em andamento. */
  async idle() {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }

  private engine() {
    for (const e of ENGINES) {
      const key = this.keys.key(e.provider);
      if (key) return { ...e, key, url: typeof e.url === 'function' ? e.url() : e.url, model: e.model() };
    }
    return null;
  }

  ready() {
    return !!this.engine();
  }

  /** Depois do download: transcreve se o número deixar e houver chave. */
  private auto(messageId: number) {
    const task = (async () => {
      const message = await this.prisma.chat_Message.findUnique({ where: { id: messageId }, include: { conversation: { include: { channel: true } } } });
      if (!message || message.type !== 'audio' || message.direction !== 'in' || message.origin === 'history') return;
      if (!normalizeSettings(message.conversation.channel.settings).transcrever || !this.ready()) return;
      await this.run(messageId);
    })().catch((error) => this.logger.warn(`Transcrição da mensagem ${messageId}: ${error?.message}`));
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  /** "Transcrever" na tela (qualquer áudio já baixado). */
  async request(message: { id: number; type: string; media: unknown }) {
    if (message.type !== 'audio') throw new BadRequestException('Só áudio pode ser transcrito.');
    const media = (message.media as ChatMedia | null) ?? {};
    if (!media.key) throw new BadRequestException('Baixe o áudio antes de transcrever.');
    if (!this.ready()) throw new BadRequestException('Falta a chave da Groq ou da OpenAI em Bots → Chaves de IA para transcrever áudios.');
    return this.run(message.id);
  }

  private async run(messageId: number) {
    const message = await this.prisma.chat_Message.findUnique({ where: { id: messageId }, include: { conversation: { select: { assignedUserId: true } } } });
    if (!message) return null;
    const media = (message.media as ChatMedia | null) ?? {};
    if (!media.key) return null;
    const engine = this.engine();
    if (!engine) return null;
    await this.save(message, { ...media, transcriptState: 'pending' });
    let next: ChatMedia;
    try {
      const body = await this.media.read(media.key);
      if (body.length > MAX_AUDIO) throw new Error('áudio grande demais para transcrever');
      const mimetype = (media.mimetype || 'audio/ogg').split(';')[0];
      const ext = mimetype.includes('mpeg') ? 'mp3' : mimetype.includes('mp4') || mimetype.includes('m4a') ? 'm4a' : mimetype.includes('webm') ? 'webm' : mimetype.includes('wav') ? 'wav' : 'ogg';
      const form = new FormData();
      form.append('file', new Blob([body], { type: mimetype }), `audio.${ext}`);
      form.append('model', engine.model);
      form.append('language', 'pt');
      form.append('response_format', 'json');
      form.append('temperature', '0');
      const { data } = await axios.post(engine.url, form, { headers: { Authorization: `Bearer ${engine.key}` }, timeout: 120000, maxBodyLength: MAX_AUDIO + 1024 * 1024 });
      const text = String(data?.text ?? '').replace(/\s+/g, ' ').trim();
      next = { ...media, transcript: text || '(sem fala reconhecível)', transcriptState: 'ok', transcriptBy: engine.provider };
    } catch (error) {
      const err = error as AxiosError<any>;
      this.logger.warn(`Transcrição (${engine.provider}) falhou: ${err.response?.status ?? ''} ${err.response?.data?.error?.message ?? err.message}`);
      next = { ...media, transcriptState: 'failed' };
    }
    await this.save(message, next);
    return { transcript: next.transcript ?? null, state: next.transcriptState };
  }

  private async save(message: { id: number; companyId: number; channelId: number; conversationId: number; conversation: { assignedUserId: number | null } }, media: ChatMedia) {
    await this.prisma.chat_Message.update({ where: { id: message.id }, data: { media: media as any } });
    this.events.emit({ companyId: message.companyId, kind: 'status', channelId: message.channelId, conversationId: message.conversationId, assignedUserId: message.conversation.assignedUserId });
  }
}
