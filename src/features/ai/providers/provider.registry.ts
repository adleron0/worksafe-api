import { Injectable } from '@nestjs/common';
import { AnthropicProvider } from './anthropic.provider';
import { FakeProvider } from './fake.provider';
import { GeminiProvider } from './gemini.provider';
import { OpenAICompatProvider } from './openai-compat.provider';
import { ChatProvider } from './provider.types';

/** Preço em dólar por milhão de tokens (entrada, saída, entrada em cache). */
export interface ModelPrice { input: number; output: number; cached: number }

/**
 * Tabela de preços usada para registrar o gasto e o teto mensal. É estimativa
 * (conferir na página de cada fornecedor); modelo fora da tabela usa o preço
 * do padrão do fornecedor.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'gemini-3-flash-preview': { input: 0.5, output: 3, cached: 0.05 },
  'gemini-3.1-pro-preview': { input: 2, output: 12, cached: 0.2 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cached: 0.03 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cached: 0.01 },
  'claude-sonnet-5-5': { input: 2, output: 10, cached: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cached: 0.2 },
  'gpt-5-mini': { input: 0.25, output: 2, cached: 0.025 },
  fake: { input: 1, output: 1, cached: 0 },
};

const PROVIDER_DEFAULT_PRICE: Record<string, ModelPrice> = {
  gemini: MODEL_PRICES['gemini-3.1-pro-preview'],
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
  get fast() { return process.env.AI_MODEL_FAST || 'gemini-3-flash-preview'; },
  get strong() { return process.env.AI_MODEL_STRONG || 'gemini-3.1-pro-preview'; },
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

  constructor() {
    const all: ChatProvider[] = [
      new GeminiProvider(),
      new AnthropicProvider(),
      new OpenAICompatProvider({ id: 'openai', keyEnv: 'OPENAI_API_KEY', baseURL: process.env.AI_OPENAI_BASE_URL || 'https://api.openai.com/v1' }),
      new OpenAICompatProvider({ id: 'openrouter', keyEnv: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1' }),
      new OpenAICompatProvider({ id: 'groq', keyEnv: 'GROQ_API_KEY', baseURL: 'https://api.groq.com/openai/v1' }),
      // DeepSeek só por um provedor fora da China (decisão de LGPD): a URL é obrigatória
      new OpenAICompatProvider({ id: 'deepseek', keyEnv: 'DEEPSEEK_API_KEY', baseURL: process.env.DEEPSEEK_BASE_URL || 'https://invalid.local' }),
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

  price(provider: string, model: string): ModelPrice {
    return MODEL_PRICES[model] ?? PROVIDER_DEFAULT_PRICE[provider] ?? { input: 2, output: 10, cached: 0.2 };
  }

  cost(provider: string, model: string, usage: { inputTokens: number; outputTokens: number; cachedTokens: number }): number {
    const price = this.price(provider, model);
    const fresh = Math.max(0, usage.inputTokens - usage.cachedTokens);
    return (fresh * price.input + usage.cachedTokens * price.cached + usage.outputTokens * price.output) / 1_000_000;
  }
}
