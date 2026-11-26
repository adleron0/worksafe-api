import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Qual configuração de gateway (conta Asaas) a operação em andamento usa.
 *
 * Cada CNPJ do grupo pode ter a própria conta Asaas. O checkout escolhe a conta
 * da turma; o webhook descobre a conta pelo token recebido. A partir daí, toda
 * chamada ao provedor no mesmo fluxo (criar cliente, cobrança, consultar,
 * excluir) usa a chave dessa conta. Fora de um escopo vale a conta do CNPJ padrão.
 */
export interface GatewayScope {
  companyGatewayId: number;
  /** chave que está sendo cadastrada (ainda não gravada): usada para registrar o webhook na conta certa */
  token?: string;
}

const storage = new AsyncLocalStorage<GatewayScope>();

export const gatewayScope = {
  /** Vale para o resto do fluxo assíncrono atual (a requisição em andamento). */
  enter(scope: GatewayScope) { storage.enterWith(scope); },
  run<T>(scope: GatewayScope, fn: () => Promise<T>): Promise<T> { return storage.run(scope, fn); },
  current(): GatewayScope | undefined { return storage.getStore(); },
};
