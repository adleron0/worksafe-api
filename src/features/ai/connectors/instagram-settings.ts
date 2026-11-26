import { BadRequestException } from '@nestjs/common';

/**
 * Limites e modos por ação do Instagram, por empresa (Ai_Connector.settings).
 *
 * - enabled: a ação está liberada (para a tela, os bots e o MCP);
 * - mode: 'confirmar' (cartão de confirmação) ou 'automatico' (sai direto);
 * - limitePorDia: teto do dia (fuso de Brasília). A Meta aceita no máximo 100
 *   publicações (posts + stories) por 24 horas.
 * - responder_mensagens tem também o horário em que a ferramenta do bot/MCP
 *   envia sem cartão. Quem responde o Direct sozinho é o bot do canal
 *   Instagram nas Conversas (modo sugere/triagem/atende, como no WhatsApp).
 */

export type InstagramMode = 'confirmar' | 'automatico';
export type InstagramAction = 'post' | 'story' | 'ler_mensagens' | 'responder_mensagens' | 'comentarios';
export const INSTAGRAM_ACTIONS: InstagramAction[] = ['post', 'story', 'ler_mensagens', 'responder_mensagens', 'comentarios'];

export interface SendingAction { enabled: boolean; mode: InstagramMode; limitePorDia: number }
export interface ReplyHours { inicio: string; fim: string; diasUteis: boolean }
export interface InstagramSettings {
  post: SendingAction;
  story: SendingAction;
  ler_mensagens: { enabled: boolean };
  responder_mensagens: SendingAction & { horario: ReplyHours; instrucoes: string };
  comentarios: SendingAction;
}

export const META_PUBLISH_CAP = 100;
const MAX_INSTRUCTIONS = 4000;
const LIMITS: Record<Exclude<InstagramAction, 'ler_mensagens'>, { max: number; label: string }> = {
  post: { max: META_PUBLISH_CAP, label: 'posts' },
  story: { max: META_PUBLISH_CAP, label: 'stories' },
  responder_mensagens: { max: 1000, label: 'respostas no Direct' },
  comentarios: { max: 1000, label: 'respostas a comentários' },
};
export const ACTION_LABEL: Record<InstagramAction, string> = {
  post: 'Publicar posts e carrosséis', story: 'Publicar stories', ler_mensagens: 'Ler mensagens do Direct',
  responder_mensagens: 'Responder mensagens do Direct', comentarios: 'Comentários (ler, responder e ocultar)',
};

export function defaultInstagramSettings(): InstagramSettings {
  return {
    post: { enabled: true, mode: 'confirmar', limitePorDia: 5 },
    story: { enabled: true, mode: 'confirmar', limitePorDia: 10 },
    ler_mensagens: { enabled: true },
    responder_mensagens: { enabled: true, mode: 'confirmar', limitePorDia: 50, horario: { inicio: '08:00', fim: '18:00', diasUteis: true }, instrucoes: '' },
    comentarios: { enabled: true, mode: 'confirmar', limitePorDia: 50 },
  };
}

/** O que está gravado, completado com os padrões (gravado antigo ou parcial nunca quebra). */
export function readInstagramSettings(raw: unknown): InstagramSettings {
  const base = defaultInstagramSettings();
  const saved = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const merge = <T extends object>(def: T, value: unknown): T => (value && typeof value === 'object' ? { ...def, ...(value as object) } : def);
  return {
    post: merge(base.post, saved.post),
    story: merge(base.story, saved.story),
    ler_mensagens: merge(base.ler_mensagens, saved.ler_mensagens),
    responder_mensagens: { ...merge(base.responder_mensagens, saved.responder_mensagens), horario: merge(base.responder_mensagens.horario, saved.responder_mensagens?.horario) },
    comentarios: merge(base.comentarios, saved.comentarios),
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Valida o que a tela mandou (pode vir parcial: o que não veio fica como está).
 * Erros em português, apontando a ação.
 */
export function validateInstagramSettings(current: InstagramSettings, input: unknown): InstagramSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Envie as configurações como um objeto');
  const body = input as Record<string, any>;
  const unknown = Object.keys(body).filter((key) => !INSTAGRAM_ACTIONS.includes(key as InstagramAction));
  if (unknown.length) throw new BadRequestException(`Ação desconhecida: ${unknown.join(', ')}`);
  const next: InstagramSettings = JSON.parse(JSON.stringify(current));

  for (const action of INSTAGRAM_ACTIONS) {
    const value = body[action];
    if (value === undefined) continue;
    const label = ACTION_LABEL[action];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException(`${label}: configuração inválida`);
    const target = next[action] as Record<string, any>;
    if (value.enabled !== undefined) {
      if (typeof value.enabled !== 'boolean') throw new BadRequestException(`${label}: "ligado" precisa ser sim ou não`);
      target.enabled = value.enabled;
    }
    if (action === 'ler_mensagens') continue;
    if (value.mode !== undefined) {
      if (!['confirmar', 'automatico'].includes(value.mode)) throw new BadRequestException(`${label}: o modo precisa ser "confirmar" ou "automatico"`);
      target.mode = value.mode;
    }
    if (value.limitePorDia !== undefined) {
      const limit = LIMITS[action];
      if (!Number.isInteger(value.limitePorDia) || value.limitePorDia < 0 || value.limitePorDia > limit.max) throw new BadRequestException(`${label}: o limite por dia precisa ser um número inteiro de 0 a ${limit.max}`);
      target.limitePorDia = value.limitePorDia;
    }
    if (action === 'responder_mensagens') {
      if (value.horario !== undefined) {
        const hours = value.horario;
        if (!hours || typeof hours !== 'object') throw new BadRequestException(`${label}: horário inválido`);
        for (const key of ['inicio', 'fim'] as const) {
          if (hours[key] !== undefined) {
            if (typeof hours[key] !== 'string' || !TIME.test(hours[key])) throw new BadRequestException(`${label}: o horário de ${key === 'inicio' ? 'início' : 'fim'} precisa estar no formato HH:MM`);
            target.horario[key] = hours[key];
          }
        }
        if (hours.diasUteis !== undefined) {
          if (typeof hours.diasUteis !== 'boolean') throw new BadRequestException(`${label}: "só dias úteis" precisa ser sim ou não`);
          target.horario.diasUteis = hours.diasUteis;
        }
        if (target.horario.inicio >= target.horario.fim) throw new BadRequestException(`${label}: o horário de início precisa ser antes do fim`);
      }
      if (value.instrucoes !== undefined) {
        if (typeof value.instrucoes !== 'string') throw new BadRequestException(`${label}: as instruções precisam ser texto`);
        if (value.instrucoes.length > MAX_INSTRUCTIONS) throw new BadRequestException(`${label}: as instruções passam de ${MAX_INSTRUCTIONS} caracteres`);
        target.instrucoes = value.instrucoes.trim();
      }
    }
  }
  if (next.post.limitePorDia + next.story.limitePorDia > META_PUBLISH_CAP) {
    throw new BadRequestException(`A Meta aceita no máximo ${META_PUBLISH_CAP} publicações por dia: a soma dos limites de posts e stories passa disso`);
  }
  return next;
}

/** Hora e dia da semana em Brasília. */
export function spNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { time: `${hour}:${get('minute')}`, weekday: get('weekday') };
}

/** Dentro do horário das respostas automáticas? */
export function withinReplyHours(hours: ReplyHours, date = new Date()): boolean {
  const now = spNow(date);
  if (hours.diasUteis && ['Sat', 'Sun'].includes(now.weekday)) return false;
  return now.time >= hours.inicio && now.time < hours.fim;
}

/** Início e fim do dia (Brasília, UTC-3 fixo) que contém a data. */
export function spDayRange(date = new Date()): { start: Date; end: Date } {
  const shifted = new Date(date.getTime() - 3 * 3600000);
  const day = shifted.toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00-03:00`);
  return { start, end: new Date(start.getTime() + 86400000) };
}

/** Que ação cada tipo de post usa. */
export const KIND_ACTION_OF: Record<'feed' | 'story' | 'carousel', 'post' | 'story'> = { feed: 'post', carousel: 'post', story: 'story' };
