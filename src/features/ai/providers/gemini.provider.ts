import { GoogleGenAI, type Content, type Part } from '@google/genai';
import { callId, ChatMessage, ChatProvider, ChatRequest, ChatResponse, ProviderUnavailableError, rawFor } from './provider.types';

/**
 * Gemini pelo SDK atual (@google/genai). Substitui o fornecedor antigo, que
 * usava o pacote descontinuado @google/generative-ai por import dinâmico.
 *
 * Os modelos com raciocínio devolvem uma assinatura (thoughtSignature) nas
 * partes da resposta; ela precisa voltar intacta na chamada seguinte, por isso
 * a resposta do modelo é guardada crua e reaproveitada.
 */
export class GeminiProvider implements ChatProvider {
  readonly id = 'gemini';
  private client: GoogleGenAI | null = null;

  private key(): string {
    return process.env.GEMINI_API_KEY || '';
  }

  available(): boolean {
    return this.key().length > 0;
  }

  private sdk(): GoogleGenAI {
    if (!this.available()) throw new ProviderUnavailableError(this.id);
    if (!this.client) this.client = new GoogleGenAI({ apiKey: this.key(), ...(process.env.AI_GEMINI_BASE_URL ? { httpOptions: { baseUrl: process.env.AI_GEMINI_BASE_URL } } : {}) });
    return this.client;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const contents = this.toContents(request.messages, request.model);
    const response = await this.sdk().models.generateContent({
      model: request.model,
      contents,
      config: {
        systemInstruction: request.system,
        maxOutputTokens: request.maxOutputTokens ?? 8192,
        tools: request.tools.length
          ? [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema })) }]
          : undefined,
      },
    });

    const candidate = response.candidates?.[0];
    const parts: Part[] = candidate?.content?.parts ?? [];
    const toolCalls = parts
      .filter((part) => part.functionCall)
      .map((part) => ({ id: part.functionCall?.id || callId(), name: part.functionCall?.name || '', input: (part.functionCall?.args as Record<string, unknown>) ?? {} }));
    // devolve o id gerado para dentro do raw, para casar com a resposta
    let index = 0;
    const rawParts = parts.map((part) => (part.functionCall ? { ...part, functionCall: { ...part.functionCall, id: toolCalls[index++].id } } : part));
    const text = parts.filter((part) => part.text && !part.thought).map((part) => part.text).join('');
    const usage = response.usageMetadata;
    const finish = String(candidate?.finishReason ?? '');
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        // o raciocínio é cobrado como saída
        outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
        cachedTokens: usage?.cachedContentTokenCount ?? 0,
      },
      stopReason: toolCalls.length ? 'tool_use' : finish === 'MAX_TOKENS' ? 'max_tokens' : finish === 'SAFETY' ? 'refusal' : 'end',
      raw: { role: 'model', parts: rawParts },
    };
  }

  private toContents(messages: ChatMessage[], model: string): Content[] {
    const contents: Content[] = [];
    for (const message of messages) {
      if (message.role === 'user') {
        const parts: Part[] = [];
        for (const image of message.images ?? []) parts.push({ inlineData: { mimeType: image.mediaType, data: image.base64 } });
        parts.push({ text: message.text || ' ' });
        contents.push({ role: 'user', parts });
      } else if (message.role === 'assistant') {
        const raw = rawFor(message, this.id, model) as Content | undefined;
        if (raw?.parts?.length) {
          contents.push({ role: 'model', parts: raw.parts });
          continue;
        }
        const parts: Part[] = [];
        if (message.text) parts.push({ text: message.text });
        for (const call of message.toolCalls ?? []) parts.push({ functionCall: { id: call.id, name: call.name, args: call.input } });
        if (parts.length) contents.push({ role: 'model', parts });
      } else {
        contents.push({
          role: 'user',
          parts: message.results.map((result) => ({
            functionResponse: { id: result.toolCallId, name: result.name, response: result.isError ? { error: result.content } : { output: result.content } },
          })),
        });
      }
    }
    return contents;
  }
}
