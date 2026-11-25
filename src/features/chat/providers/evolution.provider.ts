import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import axios, { AxiosError, AxiosInstance } from 'axios';

/**
 * Adaptador do WhatsApp pelo Evolution API (servidor próprio, não oficial).
 * O resto do sistema só fala com esta porta; trocar pelo WhatsApp oficial
 * depois é escrever outro adaptador com os mesmos métodos.
 */

export type ProviderState = 'open' | 'connecting' | 'close';
export interface ConnectResult { qr: string | null; pairingCode: string | null; state: ProviderState }
export interface SendResult { externalId: string | null }

export const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED', 'SEND_MESSAGE', 'MESSAGES_SET'];

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly disconnected = false) { super(message); }
}

@Injectable()
export class EvolutionProvider {
  private readonly logger = new Logger(EvolutionProvider.name);

  ready(): boolean {
    return !!(process.env.EVOLUTION_URL && process.env.EVOLUTION_API_KEY);
  }

  private client(): AxiosInstance {
    if (!this.ready()) throw new ServiceUnavailableException('O servidor do WhatsApp não está configurado (EVOLUTION_URL e EVOLUTION_API_KEY).');
    return axios.create({
      baseURL: process.env.EVOLUTION_URL!.replace(/\/+$/, ''),
      headers: { apikey: process.env.EVOLUTION_API_KEY!, 'Content-Type': 'application/json' },
      timeout: 20000,
    });
  }

  private fail(error: unknown, what: string): never {
    const err = error as AxiosError<any>;
    const status = err.response?.status;
    const body = err.response?.data;
    const detail = Array.isArray(body?.response?.message) ? body.response.message.join('; ') : body?.response?.message ?? body?.message ?? err.message;
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    const disconnected = /not connected|connection closed|instance.*(does not exist|not found)|close/i.test(text);
    this.logger.warn(`Evolution (${what}) falhou: ${status ?? ''} ${text}`);
    throw new ProviderError(`WhatsApp: ${what} falhou (${text || 'sem resposta do servidor'})`, status, disconnected);
  }

  async createInstance(name: string, webhook: { url: string; secret: string }): Promise<void> {
    try {
      await this.client().post('/instance/create', {
        instanceName: name,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        groupsIgnore: true,
        rejectCall: false,
        alwaysOnline: false,
        readMessages: false,
        readStatus: false,
        syncFullHistory: false,
        webhook: { url: webhook.url, byEvents: false, base64: false, headers: { 'x-ws-chat-secret': webhook.secret }, events: WEBHOOK_EVENTS },
      });
    } catch (error) {
      this.fail(error, 'criar a conexão');
    }
  }

  async setWebhook(name: string, webhook: { url: string; secret: string }): Promise<void> {
    try {
      await this.client().post(`/webhook/set/${encodeURIComponent(name)}`, {
        webhook: { enabled: true, url: webhook.url, byEvents: false, base64: false, headers: { 'x-ws-chat-secret': webhook.secret }, events: WEBHOOK_EVENTS },
      });
    } catch (error) {
      this.fail(error, 'configurar o webhook');
    }
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.client().get(`/instance/connectionState/${encodeURIComponent(name)}`);
      return true;
    } catch (error) {
      if ((error as AxiosError).response?.status === 404) return false;
      this.fail(error, 'consultar a conexão');
    }
  }

  async state(name: string): Promise<ProviderState> {
    try {
      const { data } = await this.client().get(`/instance/connectionState/${encodeURIComponent(name)}`);
      return (data?.instance?.state ?? data?.state ?? 'close') as ProviderState;
    } catch (error) {
      if ((error as AxiosError).response?.status === 404) return 'close';
      this.fail(error, 'consultar a conexão');
    }
  }

  /** QR code (imagem base64) ou, com o número, código de pareamento de 8 letras. */
  async connect(name: string, phone?: string): Promise<ConnectResult> {
    try {
      if (phone) await this.client().delete(`/instance/logout/${encodeURIComponent(name)}`).catch(() => undefined);
      const { data } = await this.client().get(`/instance/connect/${encodeURIComponent(name)}`, { params: phone ? { number: phone } : undefined });
      const state = (data?.instance?.state as ProviderState) ?? (data?.base64 || data?.code ? 'connecting' : 'open');
      return { qr: data?.base64 ?? null, pairingCode: data?.pairingCode ?? null, state };
    } catch (error) {
      this.fail(error, 'gerar o QR code');
    }
  }

  async logout(name: string): Promise<void> {
    await this.client().delete(`/instance/logout/${encodeURIComponent(name)}`).catch(() => undefined);
  }

  async remove(name: string): Promise<void> {
    await this.client().delete(`/instance/logout/${encodeURIComponent(name)}`).catch(() => undefined);
    await this.client().delete(`/instance/delete/${encodeURIComponent(name)}`).catch(() => undefined);
  }

  /** Envia texto mostrando "digitando…" por `typingMs` antes (o Evolution segura o envio). */
  async sendText(name: string, to: string, text: string, typingMs: number): Promise<SendResult> {
    try {
      const { data } = await this.client().post(`/message/sendText/${encodeURIComponent(name)}`, { number: to, text, delay: typingMs, linkPreview: false }, { timeout: 20000 + typingMs });
      return { externalId: data?.key?.id ?? null };
    } catch (error) {
      this.fail(error, 'enviar a mensagem');
    }
  }

  async markRead(name: string, remoteJid: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.client()
      .post(`/chat/markMessageAsRead/${encodeURIComponent(name)}`, { readMessages: ids.map((id) => ({ remoteJid, fromMe: false, id })) })
      .catch((error) => this.logger.warn(`Evolution: marcar como lida falhou: ${error?.message}`));
  }

  async profilePicture(name: string, jid: string): Promise<string | null> {
    try {
      const { data } = await this.client().post(`/chat/fetchProfilePictureUrl/${encodeURIComponent(name)}`, { number: jid });
      return data?.profilePictureUrl ?? null;
    } catch {
      return null;
    }
  }
}
