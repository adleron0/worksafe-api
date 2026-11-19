import { BadRequestException, Injectable } from '@nestjs/common';
import { AnthropicProvider } from './anthropic.provider';
import { FakeProvider } from './fake.provider';
import { GeminiProvider } from './gemini.provider';
import { OpenAICompatProvider } from './openai-compat.provider';
import { ProviderKeyStore } from './provider-keys.service';
import { ChatProvider } from './provider.types';

/** Preço em dólar por milhão de tokens (entrada, saída, entrada em cache). */
export interface ModelPrice { input: number; output: number; cached: number }

/** Modelo que aparece na escolha da tela, com preço e para que serve. */
export interface CatalogModel {
  id: string;
  provider: string;
  label: string;
  note: string;
  recommended?: boolean;
  price: ModelPrice;
  /** Preço que passa a valer numa data (o fornecedor já anunciou). */
  next?: { from: string; price: ModelPrice };
}

/**
 * Modelos oferecidos na tela, do recomendado para os demais. Preços em dólar
 * por milhão de tokens, conferidos nas páginas dos fornecedores em 19/11/2026.
 */
export const MODEL_CATALOG: CatalogModel[] = [
  { id: 'gemini-4-hydrogen', provider: 'gemini', label: 'Gemini 4 Hydrogen', recommended: true, note: 'Melhor custo-benefício: bom com ferramentas e tarefas de várias etapas, rápido.', price: { input: 1.5, output: 7.5, cached: 0.075 } },
  { id: 'gemini-4-neon', provider: 'gemini', label: 'Gemini 4 Neon', note: 'Mais caprichado em tarefas longas e difíceis; custa o dobro do Hydrogen.', price: { input: 3, output: 15, cached: 0.15 } },
  { id: 'gemini-3.8-flash', provider: 'gemini', label: 'Gemini 3.8 Flash', note: 'Geração anterior; erra mais com ferramentas. Dobra de preço em 1º/jan/2027.', price: { input: 0.75, output: 3.75, cached: 0.075 }, next: { from: '2027-01-01', price: { input: 1.5, output: 7.5, cached: 0.15 } } },
  { id: 'gemini-3.5-flash-lite', provider: 'gemini', label: 'Gemini 3.5 Flash-Lite', note: 'O mais barato do Google; só para perguntas simples.', price: { input: 0.3, output: 2.5, cached: 0.03 } },
  { id: 'gemini-4-carbon', provider: 'gemini', label: 'Gemini 4 Carbon', note: 'Para problemas muito pesados; exagero para os bots. Dobra de preço em 1º/dez/2026.', price: { input: 2, output: 10, cached: 0.1 }, next: { from: '2026-12-01', price: { input: 4, output: 20, cached: 0.2 } } },
  { id: 'claude-haiku-5-5', provider: 'anthropic', label: 'Claude Haiku 5.5', note: 'Muito barato e rápido; precisa da chave da Anthropic.', price: { input: 0.1, output: 0.5, cached: 0.01 } },
  { id: 'claude-sonnet-5-5', provider: 'anthropic', label: 'Claude Sonnet 5.5', note: 'Forte e cuidadoso; precisa da chave da Anthropic.', price: { input: 2, output: 10, cached: 0.1 } },
];

/**
 * Preços usados para registrar o gasto e o teto mensal: os do catálogo mais
 * alguns modelos antigos. É estimativa; modelo fora da tabela usa o preço do
 * padrão do fornecedor.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  ...Object.fromEntries(MODEL_CATALOG.map((model) => [model.id, model.price])),
  'gemini-4-argon': { input: 2, output: 10, cached: 0.1 },
  'gemini-3-flash-preview': { input: 0.5, output: 3, cached: 0.05 },
  'gemini-3.1-pro-preview': { input: 2, output: 12, cached: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cached: 0.2 },
  'gpt-5-mini': { input: 0.25, output: 2, cached: 0.025 },
  fake: { input: 1, output: 1, cached: 0 },
};

/** Preços anunciados para uma data (vale do dia em diante). */
const PRICE_CHANGES: Record<string, { from: string; price: ModelPrice }[]> = {
  ...Object.fromEntries(MODEL_CATALOG.filter((model) => model.next).map((model) => [model.id, [model.next!]])),
  'gemini-4-argon': [{ from: '2026-12-01', price: { input: 4, output: 20, cached: 0.2 } }],
};

/** Preço do modelo numa data, já com os aumentos anunciados. */
export function priceAt(model: string, at: Date = new Date()): ModelPrice | undefined {
  const day = at.toISOString().slice(0, 10);
  const change = (PRICE_CHANGES[model] ?? []).filter((item) => item.from <= day).pop();
  return change?.price ?? MODEL_PRICES[model];
}

/** Custo estimado de 1.000 mensagens (perfil medido nos bots: ~3.000 tokens de entrada e ~300 de saída). */
export function costPerThousand(price: ModelPrice): number {
  return Math.round((3000 * price.input + 300 * price.output) / 1000 * 100) / 100;
}

const PROVIDER_DEFAULT_PRICE: Record<string, ModelPrice> = {
  gemini: MODEL_PRICES['gemini-4-hydrogen'],
  anthropic: MODEL_PRICES['claude-sonnet-5-5'],
  openai: { input: 2, output: 8, cached: 0.5 },
  openrouter: { input: 2, output: 8, cached: 0.5 },
  groq: { input: 0.6, output: 0.8, cached: 0.6 },
  deepseek: { input: 0.6, output: 2, cached: 0.1 },
  fake: MODEL_PRICES.fake,
};

/** Modelos padrão: "rápido" para consultas, "forte" para ações com várias etapas. */
export const DEFAULT_MODELS = {
  get provider() { return process.env.AI_DEFAULT_PROVIDER || 'gemini'; },
  get fast() { return process.env.AI_MODEL_FAST || 'gemini-4-hydrogen'; },
  get strong() { return process.env.AI_MODEL_STRONG || 'gemini-4-hydrogen'; },
};

/** Fornecedores que aparecem na tela de configuração. */
export const PROVIDER_LABELS: Record<string, string> = {
  gemini: 'Google Gemini',
  anthropic: 'Anthropic Claude',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  deepseek: 'DeepSeek (hospedado fora da China)',
};

@Injectable()
export class ProviderRegistry {
  private readonly providers = new Map<string, ChatProvider>();

  constructor(private readonly keys: ProviderKeyStore) {
    // a chave vem da tela de configuração (se cadastrada) ou da variável do servidor
    const keyOf = (id: string) => keys.key(id);
    const all: ChatProvider[] = [
      new GeminiProvider(keyOf),
      new AnthropicProvider(keyOf),
      new OpenAICompatProvider({ id: 'openai', keyEnv: 'OPENAI_API_KEY', baseURL: process.env.AI_OPENAI_BASE_URL || 'https://api.openai.com/v1' }, keyOf),
      new OpenAICompatProvider({ id: 'openrouter', keyEnv: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1' }, keyOf),
      new OpenAICompatProvider({ id: 'groq', keyEnv: 'GROQ_API_KEY', baseURL: 'https://api.groq.com/openai/v1' }, keyOf),
      // DeepSeek só por um provedor fora da China (decisão de LGPD): a URL é obrigatória
      new OpenAICompatProvider({ id: 'deepseek', keyEnv: 'DEEPSEEK_API_KEY', baseURL: process.env.DEEPSEEK_BASE_URL || 'https://invalid.local' }, keyOf),
      new FakeProvider(),
    ];
    for (const provider of all) this.providers.set(provider.id, provider);
  }

  get(id: string): ChatProvider | undefined {
    if (id === 'deepseek' && !process.env.DEEPSEEK_BASE_URL) return undefined;
    return this.providers.get(id);
  }

  /** Fornecedores com chave configurada (para a tela e para o aviso de "sem chave"). */
  status(): { id: string; label: string; available: boolean }[] {
    return Object.entries(PROVIDER_LABELS).map(([id, label]) => ({ id, label, available: !!this.get(id)?.available() }));
  }

  /** Modelos para escolher na tela, com preço de hoje e se o fornecedor tem chave. */
  models() {
    const today = new Date().toISOString().slice(0, 10);
    return MODEL_CATALOG.map((model) => {
      const price = priceAt(model.id) ?? model.price;
      const upcoming = model.next && model.next.from > today ? model.next : null;
      return {
        id: model.id, provider: model.provider, providerLabel: PROVIDER_LABELS[model.provider] ?? model.provider, label: model.label, note: model.note,
        recommended: !!model.recommended, available: !!this.get(model.provider)?.available(), price,
        perThousand: costPerThousand(price),
        upcoming: upcoming ? { from: upcoming.from, perThousand: costPerThousand(upcoming.price) } : null,
      };
    });
  }

  /** Chaves por fornecedor: de onde vem (tela/servidor) e o final da cadastrada na tela. */
  async keyList() {
    const rows = await this.keys.list();
    return rows.filter((row) => PROVIDER_LABELS[row.provider]).map((row) => ({ ...row, label: PROVIDER_LABELS[row.provider], unavailableReason: row.provider === 'deepseek' && !process.env.DEEPSEEK_BASE_URL ? 'Falta DEEPSEEK_BASE_URL no servidor' : null }));
  }

  /** Testa a chave no fornecedor (sem gastar tokens) e guarda criptografada. */
  async saveKey(id: string, rawKey: unknown, userId: number | null) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!PROVIDER_LABELS[id]) throw new BadRequestException('Fornecedor de IA inválido');
    if (key.length < 10 || key.length > 400 || /\s/.test(key)) throw new BadRequestException('Cole a chave inteira, sem espaços');
    const provider = this.providers.get(id);
    if (provider?.verify && process.env.NODE_ENV !== 'test') {
      try {
        await provider.verify(key);
      } catch (error) {
        const detail = String((error as Error)?.message ?? error).split(key).join('***').slice(0, 200);
        throw new BadRequestException(`A chave não funcionou no ${PROVIDER_LABELS[id]}: ${detail}`);
      }
    }
    await this.keys.set(id, key, userId);
    return (await this.keyList()).find((row) => row.provider === id);
  }

  async removeKey(id: string) {
    if (!PROVIDER_LABELS[id]) throw new BadRequestException('Fornecedor de IA inválido');
    await this.keys.remove(id);
    return (await this.keyList()).find((row) => row.provider === id);
  }

  price(provider: string, model: string): ModelPrice {
    return priceAt(model) ?? PROVIDER_DEFAULT_PRICE[provider] ?? { input: 2, output: 10, cached: 0.2 };
  }

  cost(provider: string, model: string, usage: { inputTokens: number; outputTokens: number; cachedTokens: number }): number {
    const price = this.price(provider, model);
    const fresh = Math.max(0, usage.inputTokens - usage.cachedTokens);
    return (fresh * price.input + usage.cachedTokens * price.cached + usage.outputTokens * price.output) / 1_000_000;
  }
}
