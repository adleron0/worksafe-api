# CLI Gerador de Entidade

Esta ferramenta CLI gera arquivos de entidade seguindo o padrão genérico usado no projeto. Ela cria todos os arquivos necessários para uma nova entidade, incluindo controller, service, module, DTOs, interfaces e configurações de segurança.

## 🚀 Uso

```bash
npm run gen:entity
```

O script é **interativo** e guiará você através do processo de criação da entidade.

## 📋 Fluxo de Geração

### 1. **Configuração do Grupo**
- Pergunta se a entidade pertence a um grupo (ex: `clientes`, `treinamentos`)
- Se sim, solicita o nome do grupo
- Cria a estrutura de pastas adequada

### 2. **Nome da Feature**
- Solicita o nome da feature (ex: `user`, `product`)
- **Verifica automaticamente** se a entidade já existe
- Se existir, cancela a operação e lista entidades existentes

### 3. **Seleção do Modelo Prisma**
- Lista todos os modelos disponíveis no schema unificado
- Permite seleção por nome ou número da lista
- Parseia automaticamente o schema do modelo selecionado

### 4. **Configurações Adicionais**
- **Campo de Imagem**: Pergunta se deve incluir suporte a upload de imagem
  - **Otimização WebP**: Se imagem habilitada, pergunta se deseja usar conversão automática para WebP
- **CompanyId**: Pergunta se a rota exige `companyId` do token
- **Rota Upsert**: Pergunta se deve incluir rota de upsert (create/update em uma única operação)
- **Cache**: Pergunta se deseja usar cache nas rotas
  - **TTL do Cache**: Se cache habilitado, permite configurar tempo de expiração

### 5. **Revisão e Confirmação**
- Mostra os campos que serão incluídos nos DTOs
- Permite confirmar antes de gerar os arquivos

## 📁 Arquivos Gerados

A CLI gerará os seguintes arquivos na estrutura apropriada:

### Estrutura Básica
```
src/features/[grupo]/[entidade]/
├── controller.ts          # Controller com CRUD completo
├── service.ts            # Service que estende GenericService
├── module.ts             # Módulo NestJS
├── associations.ts       # Configuração de relacionamentos
├── rules.ts              # Regras de negócio e configurações
├── dto/
│   ├── create.dto.ts     # DTO para criação
│   └── update.dto.ts     # DTO para atualização
└── interfaces/
    └── interface.ts      # Interface da entidade
```

### Estrutura na Raiz (sem grupo)
```
src/features/[entidade]/
├── controller.ts
├── service.ts
├── module.ts
├── associations.ts
├── rules.ts
├── dto/
│   ├── create.dto.ts
│   └── update.dto.ts
└── interfaces/
    └── interface.ts
```

## 🔧 Funcionalidades Automáticas

### 🛡️ **Verificação de Duplicatas**
- **Detecta automaticamente** se a entidade já existe
- **Cancela a operação** se encontrar duplicata
- **Lista entidades existentes** para referência
- **Funciona para grupos e raiz**

### 🔒 **omitAttributes (Segurança Automática)**
- **Detecta automaticamente** campos sensíveis baseado em palavras-chave:
  - `password`, `token`, `secret`, `key`, `hash`, `salt`, `credential`, `auth`
- **Gera configuração automática** no `rules.ts`
- **Aplica automaticamente** nos filtros do controller
- **Permite sobrescrever** via query parameters

#### Exemplo de `omitAttributes` gerado:
```typescript
// Para modelo com campos sensíveis:
export const omitAttributes = ['password', 'resetToken', 'apiKey'];

// Para modelo sem campos sensíveis:
export const omitAttributes: string[] = [];
```

### ⚙️ **Regras Automáticas**
- **emptyUpdates**: Processa campos booleanos automaticamente
- **getSearchParams**: Template para critérios de unicidade
- **getUpsertWhereCondition**: Condições para identificar registros no upsert (quando habilitado)
- **Hooks**: Estrutura para lógicas customizadas incluindo hooks de upsert

## 📝 Exemplos de Uso

### Exemplo 1: Entidade Básica
```bash
$ npx ts-node src/cli/generate-entity.ts

A entidade pertence a um grupo? (s/n): n
Digite o nome da feature (ex: user, product): product
Digite o nome da rota (ex: users, products): products
Digite o nome da permission (ex: users, products): products
Digite o nome do modelo (ou número da lista): 15
Deseja incluir campo de imagem? (s/n): n
A rota exige companyId do token? (s/n): n
Deseja incluir rota de upsert? (s/n): n
Deseja usar cache nas rotas? (s/n): n
Deseja gerar a entidade com essas configurações? (s/n): s
```

### Exemplo 2: Entidade em Grupo com Upsert e Cache
```bash
$ npx ts-node src/cli/generate-entity.ts

A entidade pertence a um grupo? (s/n): s
Qual o nome do grupo? (ex: clientes): clientes
Digite o nome da feature (ex: user, product): contact
Digite o nome da rota (ex: users, products): contacts
Digite o nome da permission (ex: users, products): contacts
Digite o nome do modelo (ou número da lista): customer_contacts
Deseja incluir campo de imagem? (s/n): s
Deseja usar otimizador de imagens WebP? (s/n): s
A rota exige companyId do token? (s/n): s
Deseja incluir rota de upsert? (s/n): s
Deseja usar cache nas rotas? (s/n): s
Por quanto tempo deseja manter o cache?
   Exemplos: 300s (5 minutos), 5m, 1h, 24h, 7d
   Digite o tempo: 1h
Deseja gerar a entidade com essas configurações? (s/n): s
```

### Exemplo 3: Entidade com Imagem e Otimização WebP
```bash
$ npx ts-node src/cli/generate-entity.ts

A entidade pertence a um grupo? (s/n): n
Digite o nome da feature (ex: user, product): instructor
Digite o nome da rota (ex: users, products): instructors
Digite o nome da permission (ex: users, products): instructors
Digite o nome do modelo (ou número da lista): Instructor
Deseja incluir campo de imagem? (s/n): s
Deseja usar otimizador de imagens WebP? (s/n): s
A rota exige companyId do token? (s/n): s
Deseja incluir rota de upsert? (s/n): n
Deseja usar cache nas rotas? (s/n): s
Por quanto tempo deseja manter o cache?
   Exemplos: 300s (5 minutos), 5m, 1h, 24h, 7d
   Digite o tempo: 48h
Deseja gerar a entidade com essas configurações? (s/n): s
```

## 🔄 Após a Geração

### 1. **Importar o Módulo**
```typescript
// Para entidade na raiz:
import { ProductModule } from './features/product/product.module';

// Para entidade em grupo:
import { ContactModule } from './features/clientes/contact/contact.module';

// No app.module.ts:
imports: [..., ProductModule, ContactModule]
```

### 2. **Personalizações Necessárias**

#### **associations.ts**
```typescript
export const paramsIncludes = {
  // Configure relacionamentos
  company: { select: { id: true, name: true } },
  user: true,
};
```

#### **rules.ts**
```typescript
// Ajuste critérios de unicidade
export function getSearchParams(request: Request, CreateDto: any) {
  return {
    companyId: Number(request.user?.companyId),
    email: CreateDto.email, // Exemplo
    name: CreateDto.name,   // Exemplo
  };
}

// Personalize campos omitidos
export const omitAttributes = ['password', 'sensitiveField'];

// Ajuste processamento de campos vazios
export function emptyUpdates(UpdateDto: any) {
  if (UpdateDto.status === undefined) UpdateDto.status = false;
  return UpdateDto;
}

// Configure condições para upsert (quando habilitado)
export function getUpsertWhereCondition(request: Request, dto: any) {
  // Defina os campos únicos para identificar registros existentes
  return {
    companyId: Number(request.user?.companyId),
    email: dto.email, // Exemplo: use campo único
    // OU use combinação de campos para unicidade composta
    // AND: [
    //   { companyId: Number(request.user?.companyId) },
    //   { name: dto.name }
    // ]
  };
}
```

#### **Hooks Personalizados**
```typescript
export async function hookPreCreate(params: { 
  dto: any; 
  entity: any; 
  prisma: PrismaService; 
  logParams: any 
}) {
  // Lógica antes da criação
}

export async function hookPosCreate(params: { 
  dto: any; 
  entity: any; 
  prisma: PrismaService; 
  logParams: any 
}, created: any) {
  // Lógica após a criação
}

// Hooks para upsert (quando habilitado)
export async function hookPreUpsert(params: { 
  dto: any; 
  whereCondition: any;
  entity: any; 
  prisma: PrismaService; 
  logParams: any 
}) {
  // Lógica antes do upsert
}

export async function hookPosUpsert(params: { 
  dto: any; 
  whereCondition: any;
  entity: any; 
  prisma: PrismaService; 
  logParams: any 
}, upserted: any) {
  // Lógica após o upsert
}
```

## 🚨 Tratamento de Erros

### Entidade Duplicada
```
❌ Erro: A entidade "user" já existe!

📋 Entidades existentes na raiz:
  1. user
  2. product
  3. company

💡 Dica: Use um nome diferente para a feature ou remova a entidade existente.
```

### Modelo Não Encontrado
```
❌ Erro ao ler o modelo "InvalidModel"
```

## 🔧 Configurações Avançadas

### Permissões
```typescript
// No controller.ts - Descomente para remover permissão
// @UserPermission(`list_${entity.permission}`)

// Descomente para tornar pública
// @Public()
```

### Upload de Imagem
```typescript
// Configuração automática no controller - Padrão
@UseInterceptors(FileInterceptor('image', getMulterOptions('entity-name-image')))

// Com otimização WebP (quando habilitado)
@UseInterceptors(
  FileInterceptor('image', getOptimizedMulterOptions()),
  ImageOptimizationInterceptor,
)

// Lógica automática para adicionar imageUrl ao DTO (quando WebP habilitado)
if (file && file.location) {
  CreateDto.imageUrl = file.location;
}
```

### Rota Upsert
```typescript
// Rota gerada automaticamente quando habilitada
// Usa a mesma permissão do create
@UserPermission(`create_${entity.permission}`)
@Post('upsert')
async upsert(
  @Req() request: Request,
  @Body() upsertDto: CreateDto,
  @UploadedFile() file?: Express.MulterS3.File,
) {
  const whereCondition = getUpsertWhereCondition(request, upsertDto);
  
  return super.upsert(request, upsertDto, file, whereCondition, hooksUpsert);
}
```

### Filtros Customizados
```typescript
// No método get do controller
async get(@Req() request: Request, @Query() query: any) {
  // Adiciona omitAttributes automaticamente
  // Sempre do servidor: o cliente não escolhe o que omitir (senão
    // ?omitAttributes[]=id devolveria hash de senha e sellerConfig).
    query.omitAttributes = omitAttributes;
  return super.get(request, query, paramsIncludes, noCompany);
}
```

## 📚 Estrutura da Entidade

A entidade gerada segue o padrão genérico do projeto:

- **Service**: Estende `GenericService` com funcionalidades CRUD
- **Controller**: Estende `GenericController` com rotas padrão
- **DTOs**: Incluem validações automáticas baseadas no schema
- **Interface**: Estende o modelo Prisma correspondente
- **Rules**: Configurações de segurança e regras de negócio
- **Associations**: Configuração de relacionamentos

## 🎯 Benefícios

- ✅ **Geração Automática** de código padronizado
- ✅ **Verificação de Duplicatas** para evitar conflitos
- ✅ **Segurança Automática** com `omitAttributes`
- ✅ **Detecção Inteligente** de campos sensíveis
- ✅ **Flexibilidade** para personalizações
- ✅ **Integração Completa** com o sistema existente
- ✅ **Suporte a Grupos** para organização
- ✅ **Validações Automáticas** baseadas no schema Prisma
- ✅ **Otimização de Imagens** com conversão para WebP
- ✅ **Cache Configurável** com TTL personalizável
