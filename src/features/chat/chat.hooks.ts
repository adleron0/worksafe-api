import type { Ai_SocialMessage } from '@prisma/client';

/**
 * Ganchos sem dependência de módulo: o Instagram (módulo de IA) avisa a caixa
 * de entrada a cada mensagem do Direct gravada, sem um módulo importar o outro.
 * As Conversas registram a função quando sobem.
 */
export const chatHooks: { instagramMessage: ((row: Ai_SocialMessage) => void) | null } = { instagramMessage: null };
