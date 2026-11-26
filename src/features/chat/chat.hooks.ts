import type { Ai_SocialMessage } from '@prisma/client';

/**
 * Ganchos sem dependência de módulo: o Instagram (módulo de IA) avisa a caixa
 * de entrada a cada mensagem do Direct gravada, sem um módulo importar o outro.
 * As Conversas registram a função quando sobem.
 */
export const chatHooks: {
  instagramMessage: ((row: Ai_SocialMessage) => void) | null;
  /** mensagem nova do cliente / resposta de uma pessoa: o bot da conversa decide (registrado pelo ChatBotService) */
  botInbound: ((conversationId: number, messageId: number) => void) | null;
  botHumanReply: ((conversationId: number) => void) | null;
} = { instagramMessage: null, botInbound: null, botHumanReply: null };
