# Guia de Uso - Sistema de Encriptação/Ofuscação

## Visão Geral

O sistema permite ofuscar dados sensíveis usando Base64 antes de retorná-los ao frontend. Você pode escolher exatamente quais campos encriptar ou usar configurações predefinidas.

## Opções de Uso

### 1. Encriptação Dinâmica (RECOMENDADO)

Escolha exatamente quais campos encriptar via query params ou código:

```typescript
// No Controller - Opção 1: Via Query Params
@Get()
async findAll(@Query() query: any) {
  const filters = this.parseFilters(query);
  
  // Pega campos a encriptar do query param
  // Ex: ?encryptFields=cpf,trainee.rg,trainee.phone
  const encryptFields = query.encryptFields 
    ? query.encryptFields.split(',') 
    : [];
  
  return this.service.get(
    filters,
    entity,
    paramsIncludes,
    false,
    encryptFields // Array de campos específicos
  );
}
```

#### Exemplos de URLs:
```bash
# Encriptar apenas CPF
GET /api/certificates?encryptFields=cpf

# Encriptar CPF e RG do trainee
GET /api/certificates?encryptFields=trainee.cpf,trainee.rg

# Encriptar campos aninhados
GET /api/certificates?encryptFields=variableToReplace,trainee.cpf,company.cnpj

# Múltiplos níveis de aninhamento
GET /api/certificates?encryptFields=trainee.contact.phone,trainee.address.zipCode
```

### 2. Encriptação por Código

```typescript
// Definir campos diretamente no controller
@Get()
async findAll(@Query() query: any) {
  const filters = this.parseFilters(query);
  
  // Define campos sensíveis para encriptar
  const sensitiveFields = [
    'cpf',
    'rg',
    'trainee.cpf',
    'trainee.rg',
    'trainee.phone',
    'company.cnpj'
  ];
  
  return this.service.get(
    filters,
    entity,
    paramsIncludes,
    false,
    sensitiveFields
  );
}
```

### 3. Encriptação Condicional

```typescript
@Get()
async findAll(@Request() req, @Query() query: any) {
  const filters = this.parseFilters(query);
  
  // Encripta campos sensíveis apenas para não-admins
  let encryptFields: string[] | boolean = false;
  
  if (!req.user.isAdmin) {
    encryptFields = ['cpf', 'rg', 'trainee.cpf', 'trainee.rg'];
  }
  
  return this.service.get(
    filters,
    entity,
    paramsIncludes,
    false,
    encryptFields
  );
}
```

### 4. Encriptação Predefinida (configuração estática)

Use a configuração em `encryption.config.ts`:

```typescript
// encryption.config.ts
export const encryptionConfig: EncryptionConfig = {
  traineeCourseCertificate: {
    fields: ['variableToReplace', 'pdfUrl'],
    relations: {
      trainee: ['cpf', 'rg', 'phone'],
      company: ['cnpj', 'apiKey']
    }
  }
};

// No Controller
@Get()
async findAll(@Query() query: any) {
  const filters = this.parseFilters(query);
  
  return this.service.get(
    filters,
    entity,
    paramsIncludes,
    false,
    true // Usa configuração predefinida
  );
}
```

## Como Funciona

### Dados Originais:
```json
{
  "id": 1,
  "traineeId": 123,
  "variableToReplace": { "name": "João", "cpf": "123.456.789-00" },
  "trainee": {
    "id": 123,
    "name": "João Silva",
    "cpf": "123.456.789-00",
    "rg": "12.345.678-9"
  }
}
```

### Dados Encriptados:
```json
{
  "id": 1,
  "traineeId": 123,
  "variableToReplace": "eyJuYW1lIjoiSm/Do28iLCJjcGYiOiIxMjMuNDU2Ljc4OS0wMCJ9",
  "trainee": {
    "id": 123,
    "name": "João Silva",
    "cpf": "IjEyMy40NTYuNzg5LTAwIg==",
    "rg": "IjEyLjM0NS42NzgtOSI="
  }
}
```

## Decodificar no Frontend

### JavaScript/TypeScript:
```javascript
// Função para decodificar
function decodeBase64(value) {
  if (!value) return value;
  try {
    return JSON.parse(atob(value));
  } catch {
    return value;
  }
}

// Uso
const decodedCpf = decodeBase64(response.trainee.cpf);
const decodedVariables = decodeBase64(response.variableToReplace);
```

### React Hook Exemplo:
```typescript
import { useMemo } from 'react';

function useDecryptedData(data: any, fieldsToDecrypt: string[]) {
  return useMemo(() => {
    if (!data) return data;
    
    const decrypted = { ...data };
    fieldsToDecrypt.forEach(field => {
      if (decrypted[field]) {
        try {
          decrypted[field] = JSON.parse(atob(decrypted[field]));
        } catch {
          // Mantém original se falhar
        }
      }
    });
    
    return decrypted;
  }, [data, fieldsToDecrypt]);
}

// Uso
const certificate = useDecryptedData(response, ['variableToReplace']);
```

## Vantagens

1. **Simples**: Usa Base64, não requer bibliotecas externas
2. **Flexível**: Configure por entidade e por campo
3. **Opcional**: Pode ser ativado/desativado por requisição
4. **Recursivo**: Funciona com relações aninhadas
5. **Transparente**: Não modifica o banco de dados

## Limitações

- **Não é criptografia real**: Base64 é apenas ofuscação
- **Performance**: Adiciona processamento extra
- **Tamanho**: Base64 aumenta o tamanho dos dados em ~33%

## Segurança Real

Para dados realmente sensíveis, considere:

1. **Criptografia no banco**: Use campos criptografados no PostgreSQL
2. **HTTPS**: Sempre use conexão segura
3. **Tokens JWT**: Para autenticação
4. **Rate limiting**: Para prevenir scraping
5. **Auditoria**: Registre acessos a dados sensíveis

## Próximos Passos

Para usar criptografia real (AES, RSA), podemos:

1. Substituir `encodeBase64` por uma função de criptografia real
2. Adicionar gerenciamento de chaves
3. Implementar rotação de chaves
4. Adicionar assinatura digital

## Exemplo Completo

```typescript
// encryption.config.ts
export const encryptionConfig: EncryptionConfig = {
  user: {
    fields: ['email', 'phone', 'document'],
    relations: {
      profile: ['salary', 'bankAccount']
    }
  }
};

// user.controller.ts
@Get()
async findAll(@Request() req, @Query() query) {
  const filters = this.parseFilters(query);
  
  // Encripta dados sensíveis para usuários não-admin
  const enableEncryption = !req.user.isAdmin;
  
  return this.userService.get(
    filters,
    { model: 'user', name: 'User', route: 'users', permission: 'read:users' },
    paramsIncludes,
    false,
    enableEncryption
  );
}
```