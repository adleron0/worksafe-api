# Estrutura do sellerConfig

## Nova estrutura com ambientes separados

```json
{
  "sellerConfig": {
    "gateways": {
      "asaas": {
        "sandbox": {
          "accountId": "d1177263-c064-41b9-9af6-69e11552e051",
          "walletId": "fb3c33c5-6f8e-4ed9-a63a-fd2cf931425c",
          "accountStatus": "ACTIVE",
          "createdAt": "2025-09-14T21:53:34.576Z"
        },
        "production": {
          "accountId": "abc123-prod-account-id",
          "walletId": "xyz789-prod-wallet-id",
          "accountStatus": "ACTIVE",
          "createdAt": "2025-09-15T10:00:00.000Z"
        }
      }
      // Futuro: outros gateways como Stripe, PagSeguro, etc.
    },
    "createdAt": "2025-09-14T21:53:34.576Z",
    "updatedAt": "2025-09-14T22:15:00.000Z"
  }
}
```

## Vantagens desta estrutura:

1. **Separação clara entre ambientes**: Sandbox e Production têm walletIds diferentes
2. **Suporte a múltiplos gateways**: Estrutura preparada para adicionar Stripe, PagSeguro, etc.
3. **Sem exposição de API Keys**: API Keys NUNCA são salvas no sellerConfig
4. **Flexibilidade**: Permite ter conta em sandbox sem ter em produção e vice-versa

## Como funciona:

1. Quando criar um seller em **desenvolvimento** (BASE_SETUP=development):
   - Cria subconta no Asaas Sandbox
   - Salva em `sellerConfig.gateways.asaas.sandbox`

2. Quando criar um seller em **produção** (BASE_SETUP=production):
   - Cria subconta no Asaas Produção
   - Salva em `sellerConfig.gateways.asaas.production`

## Segurança:

- **API Keys**: Devem ser armazenadas em tabela separada com criptografia
- **Wallet IDs**: São públicos, podem ser salvos no sellerConfig
- **Account IDs**: São públicos, podem ser salvos no sellerConfig

## Uso em Split Payments:

```typescript
// Obter walletId correto baseado no ambiente
const environment = isSandbox ? 'sandbox' : 'production';
const walletId = user.sellerConfig?.gateways?.asaas?.[environment]?.walletId;

if (walletId) {
  // Criar split payment com este walletId
  const split = {
    walletId: walletId,
    percentualValue: 10, // 10% de comissão
  };
}
```