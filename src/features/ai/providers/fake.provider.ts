import { ChatProvider, ChatRequest, ChatResponse, ChatToolCall, rawFor } from './provider.types';

export type FakeStep = (request: ChatRequest) => { text?: string; toolCalls?: Omit<ChatToolCall, 'id'>[] | ChatToolCall[] };
export type FakeRequest = ChatRequest & { provider: string; rawSeen: number };

/**
 * Fornecedor simulado, só para a suíte e2e: devolve as respostas de um roteiro
 * em ordem, sem chamar ninguém. Fora do ambiente de teste ele não aparece.
 * Há dois (fake e fake2), com o mesmo roteiro, para testar troca de fornecedor.
 */
export class FakeProvider implements ChatProvider {
  readonly readsPdf = true;
  private static steps: FakeStep[] = [];
  static requests: FakeRequest[] = [];
  /** Devolve um "raw" próprio (como Gemini/Claude) para conferir que ele não vaza para outro fornecedor. */
  static withRaw = false;
  /** Fornecedores simulados "sem chave". */
  static disabled = new Set<string>();

  constructor(readonly id: string = 'fake') {}

  static script(steps: FakeStep[]): void {
    FakeProvider.steps = [...steps];
    FakeProvider.requests = [];
  }

  available(): boolean {
    return process.env.NODE_ENV === 'test' && !FakeProvider.disabled.has(this.id);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // como os adaptadores reais: o raw só é reaproveitado pelo mesmo fornecedor e modelo
    const rawSeen = request.messages.filter((message) => message.role === 'assistant' && rawFor(message, this.id, request.model) !== undefined).length;
    FakeProvider.requests.push({ ...JSON.parse(JSON.stringify(request)), provider: this.id, rawSeen });
    const step = FakeProvider.steps.shift();
    const out = step ? step(request) : { text: 'Sem roteiro.' };
    let n = 0;
    const toolCalls = (out.toolCalls ?? []).map((call) => ({ id: 'id' in call && call.id ? String(call.id) : `fake_${FakeProvider.requests.length}_${n++}`, name: call.name, input: call.input }));
    return {
      text: out.text ?? '',
      toolCalls,
      usage: { inputTokens: 1000, outputTokens: 100, cachedTokens: 0 },
      stopReason: toolCalls.length ? 'tool_use' : 'end',
      raw: FakeProvider.withRaw ? { by: this.id } : undefined,
    };
  }
}
