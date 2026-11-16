/**
 * Regras da página de inscrição da turma (layouts e teste A/B). Tudo aqui é
 * informativo: nada participa de pagamento, cupom, quota ou confirmação.
 */
export const LANDING_LAYOUTS = ['classico', 'impacto', 'direto', 'narrativa'] as const;
export type LandingLayout = (typeof LANDING_LAYOUTS)[number];

export const LANDING_EVENTS = ['view', 'block', 'cta_click', 'form_start', 'submit', 'whatsapp_click'] as const;

/** Conteúdo da página fica pequeno; acima disso é engano (ex.: imagem em base64). */
export const LANDING_CONTENT_MAX_BYTES = 200_000;

export const isLayout = (value: unknown): value is LandingLayout =>
  typeof value === 'string' && (LANDING_LAYOUTS as readonly string[]).includes(value);

/** Layout válido ou null (vazio, "classico" explícito vale). */
export const layoutOrNull = (value: unknown): LandingLayout | null => (isLayout(value) ? value : null);

/** Lista de layouts do teste: só válidos, sem repetição. */
export const layoutList = (value: unknown): LandingLayout[] => {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.filter(isLayout))];
};

const VISITOR = /^[a-zA-Z0-9-]{8,40}$/;
export const visitorOrNull = (value: unknown): string | null =>
  typeof value === 'string' && VISITOR.test(value) ? value : null;

/** Texto curto opcional: corta no limite e descarta vazio. */
export const shortText = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, max);
  return text || null;
};

/** Robôs e pré-visualizadores de link não entram na conta do teste. */
export const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|headless|lighthouse|pingdom|curl|wget|python|axios|node-fetch/i;

/** Campos de origem que a inscrição aceita da página (sanitizados). */
export function landingFieldsForSubscription(dto: Record<string, unknown>) {
  return {
    landingLayout: layoutOrNull(dto.landingLayout),
    landingVisitor: visitorOrNull(dto.landingVisitor),
    landingOption: shortText(dto.landingOption, 120),
    utmSource: shortText(dto.utmSource, 120),
    utmMedium: shortText(dto.utmMedium, 120),
    utmCampaign: shortText(dto.utmCampaign, 120),
    referrer: shortText(dto.referrer, 255),
  };
}
