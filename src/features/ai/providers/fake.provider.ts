import { ChatProvider, ChatRequest, ChatResponse, ChatToolCall } from './provider.types';

export type FakeStep = (request: ChatRequest) => { text?: string; toolCalls?: Omit<ChatToolCall, 'id'>[] | ChatToolCall[] };

/**
 * Fornecedor simulado, só para a suíte e2e: devolve as respostas de um roteiro
 * em ordem, sem chamar ninguém. Fora do ambiente de teste ele não aparece.
 */
export class FakeProvider implements ChatProvider {
  readonly id = 'fake';
  readonly readsPdf = true;
  private static steps: FakeStep[] = [];
  static requests: ChatRequest[] = [];

  static script(steps: FakeStep[]): void {
    FakeProvider.steps = [...steps];
    FakeProvider.requests = [];
  }

  available(): boolean {
    return process.env.NODE_ENV === 'test';
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    FakeProvider.requests.push(JSON.parse(JSON.stringify(request)));
    const step = FakeProvider.steps.shift();
    const out = step ? step(request) : { text: 'Sem roteiro.' };
    let n = 0;
    const toolCalls = (out.toolCalls ?? []).map((call) => ({ id: 'id' in call && call.id ? String(call.id) : `fake_${FakeProvider.requests.length}_${n++}`, name: call.name, input: call.input }));
    return {
      text: out.text ?? '',
      toolCalls,
      usage: { inputTokens: 1000, outputTokens: 100, cachedTokens: 0 },
      stopReason: toolCalls.length ? 'tool_use' : 'end',
    };
  }
}
