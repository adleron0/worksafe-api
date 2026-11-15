import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { EmailService } from 'src/features/email/email.service';

export interface Delivery { channel: string; userId: number; status: 'enviado' | 'falhou' | 'pulado'; error?: string }

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** Telefone brasileiro em E.164 (5581988887777). */
export function e164(phone: string | null | undefined): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return digits;
  return null;
}

/**
 * Avisos que saem do sistema: e-mail (mesma configuração EMAIL_* das
 * propostas) e WhatsApp pela API oficial (Cloud API), só com modelo de
 * mensagem aprovado pela Meta. Nada de conversa pelo WhatsApp: a mensagem
 * leva o link para o relatório no sistema.
 */
@Injectable()
export class NotifyService {
  constructor(private readonly email: EmailService) {}

  emailReady(): boolean {
    return !!(process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD);
  }

  whatsappReady(): boolean {
    return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_TEMPLATE);
  }

  async sendEmail(to: string, subject: string, title: string, body: string, link: string): Promise<void> {
    if (!this.emailReady()) throw new Error('E-mail não configurado (EMAIL_HOST, EMAIL_USER, EMAIL_PASSWORD)');
    this.email.initialize({
      host: process.env.EMAIL_HOST!, port: parseInt(process.env.EMAIL_PORT || '587', 10), secure: process.env.EMAIL_SECURE === 'true',
      auth: { user: process.env.EMAIL_USER!, pass: process.env.EMAIL_PASSWORD! }, from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    });
    const paragraphs = body.split(/\n{2,}/).slice(0, 40).map((block) => `<p style="white-space:pre-line">${escape(block)}</p>`).join('');
    await this.email.sendEmail({
      to, subject,
      html: `<h2>${escape(title)}</h2>${paragraphs}<p><a href="${escape(link)}">Abrir no sistema</a></p>`,
    });
  }

  /**
   * Modelo de mensagem (WHATSAPP_TEMPLATE) com dois parâmetros no corpo:
   * {{1}} = título do relatório, {{2}} = link. Ex.: "Relatório pronto: {{1}}. Veja em {{2}}".
   */
  async sendWhatsapp(phone: string, title: string, link: string): Promise<void> {
    if (!this.whatsappReady()) throw new Error('WhatsApp não configurado (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TEMPLATE)');
    const to = e164(phone);
    if (!to) throw new Error('Telefone inválido');
    const version = process.env.WHATSAPP_API_VERSION || 'v21.0';
    const response = await axios.post(`https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp', to, type: 'template',
      template: {
        name: process.env.WHATSAPP_TEMPLATE, language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'pt_BR' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: title.slice(0, 200) }, { type: 'text', text: link }] }],
      },
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }, timeout: 15000, validateStatus: () => true });
    if (response.status >= 300) throw new Error(`WhatsApp respondeu ${response.status}: ${JSON.stringify(response.data).slice(0, 300)}`);
  }
}
