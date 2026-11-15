import Anthropic from '@anthropic-ai/sdk';
import { ChatMessage, ChatProvider, ChatRequest, ChatResponse, ProviderUnavailableError, rawFor } from './provider.types';

/**
 * Claude pelo SDK oficial. A resposta crua (com os blocos de thinking) volta
 * sem alteração nas chamadas seguintes, como a API exige. O prompt das
 * ferramentas e as instruções do bot são marcados para cache: é o que mais
 * baixa o custo num loop com várias chamadas.
 */
export class AnthropicProvider implements ChatProvider {
  readonly id = 'anthropic';
  private client: Anthropic | null = null;

  private key(): string {
    return process.env.ANTHROPIC_API_KEY || '';
  }

  available(): boolean {
    return this.key().length > 0;
  }

  private sdk(): Anthropic {
    if (!this.available()) throw new ProviderUnavailableError(this.id);
    // endereço explícito: não herda ANTHROPIC_BASE_URL de outro programa da máquina
    if (!this.client) this.client = new Anthropic({ apiKey: this.key(), baseURL: process.env.AI_ANTHROPIC_BASE_URL || 'https://api.anthropic.com' });
    return this.client;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const tools: Anthropic.Tool[] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
    }));
    if (tools.length) tools[tools.length - 1].cache_control = { type: 'ephemeral' };

    const response = await this.sdk().messages.create({
      model: request.model,
      max_tokens: request.maxOutputTokens ?? 16000,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      tools,
      messages: this.toMessages(request.messages, request.model),
    });

    const toolCalls = response.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({ id: block.id, name: block.name, input: (block.input as Record<string, unknown>) ?? {} }));
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const usage = response.usage;
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        outputTokens: usage.output_tokens ?? 0,
        cachedTokens: usage.cache_read_input_tokens ?? 0,
      },
      stopReason:
        response.stop_reason === 'tool_use' ? 'tool_use'
          : response.stop_reason === 'max_tokens' ? 'max_tokens'
            : response.stop_reason === 'refusal' ? 'refusal'
              : 'end',
      raw: response.content,
    };
  }

  private toMessages(messages: ChatMessage[], model: string): Anthropic.MessageParam[] {
    const out: Anthropic.MessageParam[] = [];
    for (const message of messages) {
      if (message.role === 'user') {
        const content: Anthropic.ContentBlockParam[] = (message.images ?? []).map((image) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: image.mediaType as 'image/png', data: image.base64 },
        }));
        content.push({ type: 'text', text: message.text || ' ' });
        out.push({ role: 'user', content });
      } else if (message.role === 'assistant') {
        const raw = rawFor(message, this.id, model) as Anthropic.ContentBlockParam[] | undefined;
        if (raw?.length) {
          out.push({ role: 'assistant', content: raw });
          continue;
        }
        const content: Anthropic.ContentBlockParam[] = [];
        if (message.text) content.push({ type: 'text', text: message.text });
        for (const call of message.toolCalls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
        if (content.length) out.push({ role: 'assistant', content });
      } else {
        out.push({
          role: 'user',
          content: message.results.map((result) => ({
            type: 'tool_result' as const,
            tool_use_id: result.toolCallId,
            content: result.content,
            is_error: result.isError || undefined,
          })),
        });
      }
    }
    return out;
  }
}
