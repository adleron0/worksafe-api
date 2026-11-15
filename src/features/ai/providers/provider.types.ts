/**
 * Contrato comum dos fornecedores de IA (ports & adapters).
 *
 * A conversa é guardada num formato neutro. Cada adaptador traduz para o
 * formato do seu fornecedor e devolve a resposta normalizada. A mensagem do
 * assistente leva também o conteúdo "cru" do fornecedor (`raw`): Gemini e
 * Claude exigem receber de volta, sem alteração, partes que só eles entendem
 * (assinatura de raciocínio, blocos de thinking) para a chamada de ferramenta
 * seguinte funcionar. O `raw` só é reaproveitado pelo mesmo fornecedor.
 */

export type JsonSchema = Record<string, unknown>;

export interface ChatToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ChatToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatImage {
  mediaType: string;
  base64: string;
}

export interface ChatToolResult {
  toolCallId: string;
  name: string;
  /** JSON em texto (já resumido pelo executor). */
  content: string;
  isError?: boolean;
}

export type ChatMessage =
  | { role: 'user'; text: string; images?: ChatImage[] }
  | { role: 'assistant'; text?: string; toolCalls?: ChatToolCall[]; raw?: { provider: string; model: string; content: unknown } }
  | { role: 'tool'; results: ChatToolResult[] };

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ChatToolDef[];
  maxOutputTokens?: number;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ChatToolCall[];
  usage: ChatUsage;
  /** end | tool_use | max_tokens | refusal | error */
  stopReason: string;
  raw?: unknown;
}

export interface ChatProvider {
  /** gemini | anthropic | openai | openrouter | groq | deepseek | fake */
  readonly id: string;
  /** Tem chave configurada? Sem chave o bot avisa em vez de quebrar. */
  available(): boolean;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

export class ProviderUnavailableError extends Error {
  constructor(provider: string) {
    super(`Fornecedor de IA "${provider}" sem chave configurada`);
  }
}

/** Gera ids de chamada quando o fornecedor não manda (Gemini às vezes não manda). */
export function callId(): string {
  return `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** O raw guardado serve para este fornecedor e modelo? */
export function rawFor(message: Extract<ChatMessage, { role: 'assistant' }>, provider: string, model: string): unknown | undefined {
  if (!message.raw) return undefined;
  return message.raw.provider === provider && message.raw.model === model ? message.raw.content : undefined;
}
