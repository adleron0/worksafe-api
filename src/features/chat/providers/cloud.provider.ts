import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { decryptPayload } from 'src/utils/crypto';
import { ProviderError, SendResult } from './evolution.provider';

/**
 * Adaptador do WhatsApp oficial (WhatsApp Business Cloud API, da Meta).
 * Cada número tem as próprias credenciais (id do número, token permanente de
 * um usuário do sistema e o segredo do app para conferir o webhook).
 * Sem risco de bloqueio por cliente não oficial, mas com a regra da Meta:
 * mensagem livre só até 24 h depois da última mensagem do cliente.
 */

export interface CloudConfig {
  phoneNumberId: string;
  wabaId?: string | null;
  token: string;
  appSecret: string;
  verifyToken: string;
}

export const CLOUD_GRAPH = () => (process.env.WHATSAPP_CLOUD_GRAPH_URL || 'https://graph.facebook.com/v21.0').replace(/\/+$/, '');

@Injectable()
export class CloudProvider {
  private readonly logger = new Logger(CloudProvider.name);

  private fail(error: unknown, what: string): never {
    const err = error as AxiosError<any>;
    const status = err.response?.status;
    const meta = err.response?.data?.error;
    const text = meta?.error_user_msg || meta?.message || err.message;
    // 190 = token inválido/expirado; 131047 = fora da janela de 24 h; 131026 = número não tem WhatsApp
    const disconnected = meta?.code === 190;
    this.logger.warn(`WhatsApp oficial (${what}) falhou: ${status ?? ''} ${meta?.code ?? ''} ${text}`);
    const friendly = meta?.code === 131047 ? 'passaram mais de 24 h desde a última mensagem do cliente (a Meta só deixa mandar modelo aprovado)'
      : meta?.code === 131026 ? 'o número não recebe mensagens do WhatsApp'
      : meta?.code === 190 ? 'o token de acesso venceu ou foi revogado; cadastre um novo na configuração do número'
      : text;
    throw new ProviderError(`WhatsApp oficial: ${what} falhou (${friendly || 'sem resposta da Meta'})`, status, disconnected);
  }

  private headers(cfg: CloudConfig) {
    return { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' };
  }

  /** Confere as credenciais e devolve o número e o nome verificados. */
  async check(cfg: CloudConfig): Promise<{ phone: string | null; name: string | null }> {
    try {
      const { data } = await axios.get(`${CLOUD_GRAPH()}/${encodeURIComponent(cfg.phoneNumberId)}`, { params: { fields: 'display_phone_number,verified_name' }, headers: this.headers(cfg), timeout: 20000 });
      return { phone: String(data?.display_phone_number ?? '').replace(/\D/g, '') || null, name: data?.verified_name ?? null };
    } catch (error) {
      this.fail(error, 'conferir o número');
    }
  }

  private async post(cfg: CloudConfig, body: Record<string, unknown>, what: string): Promise<SendResult> {
    try {
      const { data } = await axios.post(`${CLOUD_GRAPH()}/${encodeURIComponent(cfg.phoneNumberId)}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', ...body }, { headers: this.headers(cfg), timeout: 30000 });
      return { externalId: data?.messages?.[0]?.id ?? null };
    } catch (error) {
      this.fail(error, what);
    }
  }

  sendText(cfg: CloudConfig, to: string, text: string): Promise<SendResult> {
    return this.post(cfg, { to, type: 'text', text: { body: text, preview_url: /https?:\/\//.test(text) } }, 'enviar a mensagem');
  }

  /** Sobe o arquivo para a Meta e manda pelo id. */
  async sendMedia(cfg: CloudConfig, to: string, file: { type: 'image' | 'video' | 'audio' | 'document'; buffer: Buffer; mimetype: string; fileName?: string | null; caption?: string }): Promise<SendResult> {
    let id: string;
    try {
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', file.mimetype);
      form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.fileName || 'arquivo');
      const { data } = await axios.post(`${CLOUD_GRAPH()}/${encodeURIComponent(cfg.phoneNumberId)}/media`, form, { headers: { Authorization: `Bearer ${cfg.token}` }, timeout: 60000, maxBodyLength: 100 * 1024 * 1024 });
      id = String(data?.id ?? '');
      if (!id) throw new Error('a Meta não devolveu o id do arquivo');
    } catch (error) {
      this.fail(error, 'enviar o arquivo');
    }
    const payload: Record<string, unknown> = { id };
    if (file.caption && file.type !== 'audio') payload.caption = file.caption;
    if (file.type === 'document' && file.fileName) payload.filename = file.fileName;
    return this.post(cfg, { to, type: file.type, [file.type]: payload }, 'enviar o arquivo');
  }

  async markRead(cfg: CloudConfig, messageId: string): Promise<void> {
    await axios.post(`${CLOUD_GRAPH()}/${encodeURIComponent(cfg.phoneNumberId)}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: messageId }, { headers: this.headers(cfg), timeout: 15000 }).catch(() => undefined);
  }

  /** Baixa a mídia recebida: primeiro o link (vale 5 min), depois o arquivo, os dois com o token. */
  async download(cfg: CloudConfig, mediaId: string): Promise<{ body: Buffer; mimetype: string | null }> {
    try {
      const { data } = await axios.get(`${CLOUD_GRAPH()}/${encodeURIComponent(mediaId)}`, { headers: this.headers(cfg), timeout: 20000 });
      const file = await axios.get<ArrayBuffer>(String(data?.url), { headers: { Authorization: `Bearer ${cfg.token}` }, responseType: 'arraybuffer', timeout: 60000, maxContentLength: 100 * 1024 * 1024 });
      return { body: Buffer.from(file.data), mimetype: data?.mime_type ?? (String(file.headers['content-type'] ?? '') || null) };
    } catch (error) {
      this.fail(error, 'baixar o arquivo');
    }
  }
}

/** Credenciais guardadas no número (criptografadas). */
export function cloudConfigOf(channel: { cloudConfig?: string | null }): CloudConfig | null {
  if (!channel.cloudConfig) return null;
  try {
    const cfg = decryptPayload(channel.cloudConfig);
    return cfg && cfg.phoneNumberId && cfg.token ? (cfg as CloudConfig) : null;
  } catch {
    return null;
  }
}
