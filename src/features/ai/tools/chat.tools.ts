import { ToolDefinition, ToolRefusal } from './tool.types';

/**
 * Ferramentas do atendimento das Conversas (WhatsApp): só existem dentro de
 * uma conversa que o bot está atendendo (triagem ou atende). Saem direto,
 * sem cartão, porque a empresa ligou esse modo no número.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const SECTOR_IDS = ['comercial', 'servicos', 'treinamentos', 'financeiro', 'operacao', 'geral'];

const inChat = (ctx: { chatConversation?: number }) => {
  if (!ctx.chatConversation) throw new ToolRefusal('Esta ferramenta só funciona dentro do atendimento das Conversas.');
};

export const CHAT_TOOLS: ToolDefinition[] = [
  {
    name: 'conversa_responder',
    title: 'Respondendo o cliente',
    description: 'Manda uma mensagem ao cliente nesta conversa (WhatsApp). Texto curto e cordial, no tom da empresa; sem inventar preço, data ou vaga. Uma mensagem por vez.',
    inputSchema: obj({ texto: str('A mensagem para o cliente') }, ['texto']),
    permissions: ['responder_conversas'],
    risk: 'sensitive',
    autoMode: true,
    botsOnly: true,
    prepare: async (ctx, input) => {
      inChat(ctx);
      const texto = String(input.texto ?? '').trim();
      if (!texto) throw new ToolRefusal('Escreva a mensagem.');
      if (texto.length > 1500) throw new ToolRefusal('Mensagem longa demais: resuma em poucas frases.');
      return { summary: 'Responder o cliente na conversa', details: [{ label: 'Mensagem', value: texto }], payload: { texto }, auto: true };
    },
    execute: async (ctx, payload, deps) => {
      if (!deps.chat) throw new ToolRefusal('Atendimento indisponível agora.');
      const out = await deps.chat.reply(ctx, String(payload.texto));
      return { message: out.message };
    },
  },
  {
    name: 'conversa_encaminhar',
    title: 'Passando para a equipe',
    description: 'Passa a conversa para uma pessoa da equipe: escolhe o setor certo e deixa um resumo de uma ou duas frases para quem for atender. Depois disso o bot para de responder nesta conversa.',
    inputSchema: obj({
      setor: str('Setor que deve atender', { enum: SECTOR_IDS }),
      resumo: str('O que o cliente quer, em uma ou duas frases'),
      motivo: str('Por que passou (ex.: pediu desconto, pediu para falar com alguém, não sei responder)'),
    }, ['resumo']),
    permissions: ['responder_conversas'],
    risk: 'sensitive',
    autoMode: true,
    botsOnly: true,
    prepare: async (ctx, input) => {
      inChat(ctx);
      const setor = input.setor ? String(input.setor) : undefined;
      if (setor && !SECTOR_IDS.includes(setor)) throw new ToolRefusal(`Setor inválido. Use um destes: ${SECTOR_IDS.join(', ')}`);
      return { summary: 'Passar a conversa para a equipe', details: [{ label: 'Resumo', value: String(input.resumo ?? '') }], payload: { setor, resumo: String(input.resumo ?? '').slice(0, 600), motivo: String(input.motivo ?? '').slice(0, 300) }, auto: true };
    },
    execute: async (ctx, payload, deps) => {
      if (!deps.chat) throw new ToolRefusal('Atendimento indisponível agora.');
      const out = await deps.chat.route(ctx, payload as { setor?: string; resumo?: string; motivo?: string });
      return { message: out.message };
    },
  },
];
