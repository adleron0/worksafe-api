import { createHash } from 'crypto';

/**
 * Regras de cada número: limites de envio, intervalo entre mensagens e horário
 * de atendimento. Os padrões foram aprovados pelo dono em 25/11/2026; os tetos
 * não podem ser passados nem pela tela (proteção contra bloqueio do número).
 */

export interface ChatLimits { novosPorDia: number; porMinuto: number; porHora: number; porDia: number }
export interface ChatInterval { min: number; max: number }
export interface ChatHours { enabled: boolean; dias: number[]; inicio: string; fim: string; mensagemFora: string }
export interface ChatSettings { limites: ChatLimits; intervalo: ChatInterval; horario: ChatHours }

export const DEFAULT_LIMITS: ChatLimits = { novosPorDia: 10, porMinuto: 12, porHora: 200, porDia: 1000 };
export const MAX_LIMITS: ChatLimits = { novosPorDia: 30, porMinuto: 20, porHora: 300, porDia: 1500 };
export const DEFAULT_INTERVAL: ChatInterval = { min: 3, max: 8 };
export const DEFAULT_HOURS: ChatHours = { enabled: false, dias: [1, 2, 3, 4, 5], inicio: '08:00', fim: '18:00', mensagemFora: '' };

export const SECTORS = [
  { id: 'comercial', name: 'Comercial' },
  { id: 'servicos', name: 'Serviços' },
  { id: 'treinamentos', name: 'Treinamentos' },
  { id: 'financeiro', name: 'Financeiro' },
  { id: 'operacao', name: 'Operação' },
  { id: 'geral', name: 'Geral' },
];

export const BOT_MODES = [
  { id: 'desligado', name: 'Desligado', description: 'Só pessoas respondem.' },
  { id: 'sugere', name: 'Sugere resposta', description: 'O bot escreve um rascunho; alguém da equipe envia, edita ou descarta.' },
  { id: 'triagem', name: 'Triagem', description: 'O bot cumprimenta, entende o assunto e passa para o setor certo.' },
  { id: 'atende', name: 'Atende', description: 'O bot conversa sozinho e passa para uma pessoa quando precisa.' },
];

const int = (value: unknown, fallback: number, min: number, max: number) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const hhmm = (value: unknown, fallback: string) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? '')) ? String(value) : fallback);

/** Lê o JSON gravado (ou o corpo da tela) e devolve sempre dentro dos tetos. */
export function normalizeSettings(raw: unknown): ChatSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const l = src.limites ?? {};
  const i = src.intervalo ?? {};
  const h = src.horario ?? {};
  const min = int(i.min, DEFAULT_INTERVAL.min, 2, 30);
  const dias = Array.isArray(h.dias) ? [...new Set(h.dias.map(Number).filter((d: number) => d >= 0 && d <= 6))].sort() as number[] : DEFAULT_HOURS.dias;
  return {
    limites: {
      novosPorDia: int(l.novosPorDia, DEFAULT_LIMITS.novosPorDia, 0, MAX_LIMITS.novosPorDia),
      porMinuto: int(l.porMinuto, DEFAULT_LIMITS.porMinuto, 1, MAX_LIMITS.porMinuto),
      porHora: int(l.porHora, DEFAULT_LIMITS.porHora, 1, MAX_LIMITS.porHora),
      porDia: int(l.porDia, DEFAULT_LIMITS.porDia, 1, MAX_LIMITS.porDia),
    },
    intervalo: { min, max: int(i.max, Math.max(min, DEFAULT_INTERVAL.max), min, 60) },
    horario: {
      enabled: h.enabled === true,
      dias,
      inicio: hhmm(h.inicio, DEFAULT_HOURS.inicio),
      fim: hhmm(h.fim, DEFAULT_HOURS.fim),
      mensagemFora: String(h.mensagemFora ?? '').slice(0, 1000),
    },
  };
}

/** Início do dia em São Paulo (para os limites "por dia"). */
export function spDayStart(now = new Date()): Date {
  const sp = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const diff = now.getTime() - sp.getTime();
  sp.setHours(0, 0, 0, 0);
  return new Date(sp.getTime() + diff);
}

export const normalizeText = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
export const textHash = (text: string) => createHash('sha256').update(normalizeText(text)).digest('hex');

const SHORTENERS = /\b(bit\.ly|tinyurl\.com|cutt\.ly|t\.co|is\.gd|rb\.gy|shorturl\.at|ow\.ly|encurtador\.com\.br|tiny\.cc|s\.id|t\.ly)\//i;
export const hasLink = (text: string) => /(https?:\/\/|www\.)\S+/i.test(text) || /\b[a-z0-9-]+\.(com|com\.br|net|org|br|io|app|site)(\/\S*)?\b/i.test(text);
export const hasShortener = (text: string) => SHORTENERS.test(text);

/** "parar", "sair", "não quero mais"… → o contato não recebe mais mensagens. */
export function isOptOut(text: string): boolean {
  const t = normalizeText(text).replace(/[.!?]+$/, '');
  return /^(parar|pare|sair|stop|cancelar inscricao|descadastrar|nao quero( mais)?( receber)?( mensagens?)?|nao me mande mais( mensagens?)?|remover meu numero)$/.test(t);
}

/** Só os dígitos, com 55 na frente quando vier número brasileiro sem DDI. */
export function phoneDigits(value: string | null | undefined): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) return `55${digits}`;
  return digits;
}

export const TERMS_VERSION = '2026-11-25';
export const TERMS = {
  version: TERMS_VERSION,
  title: 'Termo de uso do WhatsApp não oficial',
  intro: 'Esta conexão usa o WhatsApp Web por uma integração não oficial. Ela é simples e não tem custo por mensagem, mas tem riscos que a empresa precisa aceitar.',
  riscos: [
    'Os termos do WhatsApp não permitem integrações não oficiais. O número pode ser bloqueado a qualquer momento, temporária ou definitivamente.',
    'Nenhuma proteção garante que o bloqueio não aconteça. O sistema reduz o risco, mas não o elimina.',
    'Se o número for bloqueado, as conversas que já estão no sistema continuam aqui, mas a conversa no celular pode ser perdida.',
    'O WorkSafe não se responsabiliza por número bloqueado, mensagens não entregues ou perda de histórico.',
  ],
  protecoes: [
    'Sem disparo em massa: só conversas, e no máximo 10 contatos novos por dia (teto de 30).',
    'Ritmo de pessoa: intervalo entre mensagens, "digitando…" e limites por minuto, hora e dia.',
    'O mesmo texto não vai para muitos contatos em sequência.',
    'Sem link na primeira mensagem para quem nunca falou com o número, e nada de encurtadores.',
    'Quem responder "parar" ou "sair" não recebe mais mensagens.',
  ],
  boasPraticas: [
    'Use um número da empresa, nunca um número pessoal.',
    'Número novo: use normalmente no celular por 2 a 4 semanas antes de conectar.',
    'Abra o WhatsApp no celular de vez em quando: o aparelho vinculado cai se o celular ficar cerca de 14 dias desligado.',
    'Não mande mensagem para quem não pediu.',
  ],
  aceite: 'Entendo os riscos e aceito em nome da empresa.',
};

/** Está fora do horário de atendimento agora (fuso de São Paulo)? */
export function outOfHours(settings: ChatSettings, now = new Date()): boolean {
  const h = settings.horario;
  if (!h.enabled) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now).map((p) => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  const [hi, mi] = h.inicio.split(':').map(Number);
  const [hf, mf] = h.fim.split(':').map(Number);
  const start = hi * 60 + mi;
  const end = hf * 60 + mf;
  const inside = start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  return !h.dias.includes(day) || !inside;
}

/** O que aparece na lista quando a mensagem não é texto. */
const LABELS: Record<string, string> = {
  image: '📷 Foto', audio: '🎤 Áudio', video: '🎬 Vídeo', document: '📄 Documento', sticker: '💟 Figurinha', location: '📍 Localização', contact: '👤 Contato', other: 'Mensagem',
};

export const previewOf = (type: string, text: string) => (text ? text : LABELS[type] ?? 'Mensagem').replace(/\s+/g, ' ').slice(0, 200);
