/**
 * Personalidade de trabalho dos bots, no modelo dos Cinco Grandes Fatores
 * (Big Five / OCEAN), o modelo de personalidade com mais respaldo científico.
 * Cada traço vai de 1 a 5 e vira orientações de comportamento no prompt (o
 * jeito de trabalhar e de falar) e, no front, o jeito de se mexer do rosto.
 *
 * Base dos perfis prontos:
 * - Conscienciosidade é o traço que mais prevê desempenho em qualquer função
 *   (Barrick & Mount, 1991; Hurtz & Donovan, 2000) — por isso é alta em quase todos.
 * - Estabilidade emocional (baixo neuroticismo) também prevê desempenho em geral (Judge et al., 1999).
 * - Extroversão prevê desempenho em vendas e gestão (Barrick & Mount, 1991; Vinchur et al., 1998).
 * - Abertura à experiência é o traço mais ligado à criatividade (Feist, 1998) e ao aprendizado.
 * - Amabilidade prevê desempenho em trabalho de equipe e atendimento (Mount, Barrick & Stewart, 1998).
 *
 * Guardada no próprio rosto (campo avatar, último pedaço de "r:forma.cor.acessorio.olhos.jeito"):
 * o id de um perfil pronto ou "t" + os 5 níveis (ex.: "t35342"). Os rostos-modelo ("gestao") são equilibrados.
 */

export type Traits = { abertura: number; conscienciosidade: number; extroversao: number; amabilidade: number; estabilidade: number };
export const TRAIT_KEYS = ['abertura', 'conscienciosidade', 'extroversao', 'amabilidade', 'estabilidade'] as const;

export const TRAIT_LABELS: Record<keyof Traits, { label: string; low: string; high: string }> = {
  abertura: { label: 'Abertura a ideias', low: 'Convencional', high: 'Inventivo' },
  conscienciosidade: { label: 'Conscienciosidade', low: 'Flexível', high: 'Meticuloso' },
  extroversao: { label: 'Extroversão', low: 'Reservado', high: 'Expansivo' },
  amabilidade: { label: 'Amabilidade', low: 'Franco', high: 'Acolhedor' },
  estabilidade: { label: 'Estabilidade emocional', low: 'Alerta a riscos', high: 'Sereno' },
};

const t = (abertura: number, conscienciosidade: number, extroversao: number, amabilidade: number, estabilidade: number): Traits => ({ abertura, conscienciosidade, extroversao, amabilidade, estabilidade });

export const PERSONALITIES: Record<string, { label: string; fit: string; why: string; traits: Traits }> = {
  equilibrado: { label: 'Equilibrado', fit: 'Qualquer área', why: 'Tudo na média, com calma e capricho acima da média.', traits: t(3, 4, 3, 3, 4) },
  analitico: { label: 'Analítico', fit: 'Financeiro, dados', why: 'Conscienciosidade alta é o que mais prevê bom desempenho, ainda mais em trabalho com números e prazos.', traits: t(3, 5, 2, 3, 5) },
  criativo: { label: 'Criativo', fit: 'Marketing, conteúdo', why: 'Abertura a ideias é o traço mais ligado à criatividade.', traits: t(5, 3, 4, 3, 4) },
  comunicativo: { label: 'Comunicativo', fit: 'Comercial, vendas', why: 'Extroversão prevê desempenho em vendas; conscienciosidade garante o acompanhamento.', traits: t(3, 4, 5, 4, 4) },
  executor: { label: 'Executor', fit: 'Obras, operação, campo', why: 'Prático e firme: capricho alto e calma sob pressão, sem rodeio.', traits: t(2, 5, 3, 2, 5) },
  acolhedor: { label: 'Didático', fit: 'Treinamentos, suporte', why: 'Amabilidade prevê bom atendimento e trabalho em equipe; abertura ajuda a ensinar.', traits: t(4, 4, 3, 5, 4) },
  estrategico: { label: 'Estratégico', fit: 'Gestão, direção', why: 'Visão do todo (abertura) com capricho e firmeza, como em cargos de gestão.', traits: t(4, 5, 4, 3, 5) },
};

/** Jeitos antigos (só animação) que já estavam guardados em bots criados. */
const LEGACY: Record<string, string> = { normal: 'equilibrado', calma: 'analitico', agitada: 'comunicativo', curiosa: 'criativo', timida: 'acolhedor' };

/** Lê a personalidade do campo avatar. */
export function personalityOf(avatar?: string | null): { id: string; traits: Traits } {
  const last = avatar?.startsWith('r:') ? avatar.split('.').pop() ?? '' : '';
  const custom = /^t([1-5])([1-5])([1-5])([1-5])([1-5])$/.exec(last);
  if (custom) return { id: last, traits: t(+custom[1], +custom[2], +custom[3], +custom[4], +custom[5]) };
  const id = PERSONALITIES[last] ? last : LEGACY[last] ?? 'equilibrado';
  return { id, traits: PERSONALITIES[id].traits };
}

/** O que cada nível muda no trabalho. Nível 3 é o meio e não acrescenta nada. */
export const TRAIT_TEXT: Record<keyof Traits, Record<number, string>> = {
  abertura: {
    1: 'Prefira sempre o caminho já comprovado na empresa; não proponha novidades sem que peçam.',
    2: 'Fique no que é prático e conhecido; sugira mudança só quando houver um motivo claro.',
    4: 'Quando fizer sentido, ofereça uma alternativa ou um jeito melhor de fazer.',
    5: 'Traga ideias e ângulos novos, proponha duas ou três alternativas e ligue assuntos de áreas diferentes.',
  },
  conscienciosidade: {
    1: 'Vá no essencial; não se prenda a detalhes que não mudam a decisão.',
    2: 'Priorize a resposta rápida; detalhe só quando pedirem.',
    4: 'Confira os dados antes de responder e aponte pendências e prazos que achar.',
    5: 'Seja meticuloso: confira números e somas, diga de onde veio cada dado, organize em passos e avise de prazos, inconsistências e o que falta.',
  },
  extroversao: {
    1: 'Fale só o necessário, em tom sóbrio; não puxe assunto.',
    2: 'Tom sóbrio e conciso; espere a pessoa pedir antes de sugerir.',
    4: 'Tom animado e próximo; sugira o próximo passo ao final.',
    5: 'Tom caloroso e entusiasmado; tome a iniciativa: sugira próximos passos e ofereça ajuda com o que vem depois.',
  },
  amabilidade: {
    1: 'Seja franco e direto: aponte problemas e discorde quando for o caso, sem amaciar.',
    2: 'Seja objetivo e honesto, mesmo quando a notícia não é boa.',
    4: 'Seja cordial e paciente; reconheça o que a pessoa já fez.',
    5: 'Seja acolhedor e didático: explique com paciência, passo a passo, sem julgar, e confira se ficou claro.',
  },
  estabilidade: {
    1: 'Seja cauteloso: destaque riscos e o que pode dar errado antes de seguir.',
    2: 'Sinalize riscos com cuidado antes de recomendar.',
    4: 'Trate problemas com calma e objetividade.',
    5: 'Mantenha a calma diante de atrasos, erros ou cobranças: sem alarme, foque na solução.',
  },
};

/** Trecho do prompt: como este bot trabalha. Nunca passa por cima das regras. */
export function personalityPrompt(avatar?: string | null): string {
  const { id, traits } = personalityOf(avatar);
  const lines = TRAIT_KEYS.map((key) => TRAIT_TEXT[key][traits[key]]).filter(Boolean);
  if (!lines.length) return '';
  const name = PERSONALITIES[id]?.label;
  return `\n## Seu jeito de trabalhar${name ? ` (${name.toLowerCase()})` : ''}\n${lines.map((line) => `- ${line}`).join('\n')}\n- O seu jeito muda o tom e o capricho, nunca as regras acima nem as permissões.`;
}

/** Para a tela: perfis prontos, traços e o texto de cada nível. */
export function personalityCatalog() {
  return {
    profiles: Object.entries(PERSONALITIES).map(([id, item]) => ({ id, ...item })),
    traits: TRAIT_KEYS.map((key) => ({ key, ...TRAIT_LABELS[key], text: TRAIT_TEXT[key] })),
  };
}
