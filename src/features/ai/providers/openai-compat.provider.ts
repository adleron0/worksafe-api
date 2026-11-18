import OpenAI from 'openai';
import { ChatMessage, ChatProvider, ChatRequest, ChatResponse, KeyResolver, ProviderUnavailableError, rawFor } from './provider.types';

interface CompatConfig {
  id: string;
  keyEnv: string;
  baseURL?: string;
}

/**
 * Qualquer fornecedor com a API de chat da OpenAI: a própria OpenAI, Groq,
 * OpenRouter (vários modelos com uma chave só) e DeepSeek hospedado fora da
 * China. O pacote `openai` já estava no projeto.
 */
export class OpenAICompatProvider implements ChatProvider {
  readonly id: string;
  private client: OpenAI | null = null;
  private clientKey = '';

  constructor(private readonly config: CompatConfig, private readonly keyOf: KeyResolver = () => process.env[config.keyEnv] || '') {
    this.id = config.id;
  }

  private key(): string {
    return this.keyOf(this.id);
  }

  async verify(key: string): Promise<void> {
    await new OpenAI({ apiKey: key, baseURL: this.config.baseURL }).models.list();
  }

  available(): boolean {
    return this.key().length > 0;
  }

  private sdk(): OpenAI {
    const key = this.key();
    if (!key) throw new ProviderUnavailableError(this.id);
    if (!this.client || this.clientKey !== key) { this.client = new OpenAI({ apiKey: key, baseURL: this.config.baseURL }); this.clientKey = key; }
    return this.client;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.sdk().chat.completions.create({
      model: request.model,
      max_completion_tokens: request.maxOutputTokens ?? 8192,
      messages: [{ role: 'system', content: request.system }, ...this.toMessages(request.messages, request.model)],
      tools: request.tools.length
        ? request.tools.map((tool) => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }))
        : undefined,
    });
    const choice = response.choices[0];
    const message = choice?.message;
    const toolCalls = (message?.tool_calls ?? [])
      .filter((call) => call.type === 'function')
      .map((call) => {
        const fn = (call as { function: { name: string; arguments: string } }).function;
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(fn.arguments || '{}'); } catch { input = { _invalid: fn.arguments }; }
        return { id: call.id, name: fn.name, input };
      });
    return {
      text: message?.content ?? '',
      toolCalls,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        cachedTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      stopReason: toolCalls.length ? 'tool_use' : choice?.finish_reason === 'length' ? 'max_tokens' : choice?.finish_reason === 'content_filter' ? 'refusal' : 'end',
      raw: message,
    };
  }

  private toMessages(messages: ChatMessage[], model: string): OpenAI.ChatCompletionMessageParam[] {
    const out: OpenAI.ChatCompletionMessageParam[] = [];
    for (const message of messages) {
      if (message.role === 'user') {
        if (message.images?.length) {
          out.push({
            role: 'user',
            content: [
              ...message.images.map((image) => ({ type: 'image_url' as const, image_url: { url: `data:${image.mediaType};base64,${image.base64}` } })),
              { type: 'text' as const, text: message.text || ' ' },
            ],
          });
        } else {
          out.push({ role: 'user', content: message.text || ' ' });
        }
      } else if (message.role === 'assistant') {
        const raw = rawFor(message, this.id, model) as OpenAI.ChatCompletionMessage | undefined;
        if (raw) {
          out.push({ role: 'assistant', content: raw.content ?? null, tool_calls: raw.tool_calls });
          continue;
        }
        out.push({
          role: 'assistant',
          content: message.text ?? null,
          tool_calls: message.toolCalls?.length
            ? message.toolCalls.map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.input) } }))
            : undefined,
        });
      } else {
        for (const result of message.results) out.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.content });
      }
    }
    return out;
  }
}
