# PrismaService - Documentação de Uso

## Visão Geral

O `PrismaService` é uma extensão customizada do `PrismaClient` que adiciona funcionalidades essenciais para operações de banco de dados, incluindo:

- **Sistema de Logs Automático**: Registra todas as operações de CRUD automaticamente (opcional)
- **Métodos Simplificados**: Interface padronizada para operações comuns
- **Suporte a Transações**: Gerenciamento simplificado de transações
- **Soft Delete**: Implementação nativa de exclusão lógica
- **Paginação**: Suporte nativo para consultas paginadas

## Configuração

### Inicialização

O serviço é inicializado automaticamente como um provider do NestJS:

```typescript
import { PrismaService } from './prisma/prisma.service';

@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

### Logs do Banco de Dados

Os logs SQL são controlados pela variável de ambiente `LOGS_DB`:

```bash
# .env
LOGS_DB=true  # Habilita logs detalhados do Prisma
```

## Métodos Disponíveis

### 1. selectOne()
Busca um único registro por condições únicas (geralmente ID).

```typescript
// Buscar usuário por ID
const user = await prismaService.selectOne('users', {
  where: { id: 1 },
  include: { 
    company: true,
    roles: true 
  }
});
```

### 2. selectFirst()
Busca o primeiro registro que atende às condições.

```typescript
// Buscar primeiro usuário ativo de uma empresa
const firstUser = await prismaService.selectFirst('users', {
  where: { 
    companyId: 1,
    active: true 
  },
  include: { company: true }
});
```

### 3. select()
Busca múltiplos registros com ordenação opcional.

```typescript
// Buscar todos os usuários ativos
const users = await prismaService.select(
  'users',
  {
    where: { active: true },
    include: { roles: true }
  },
  [{ createdAt: 'desc' }] // ordenação opcional (padrão: { id: 'desc' })
);
```

### 4. selectPaging()
Busca registros com paginação.

```typescript
// Buscar usuários com paginação
const result = await prismaService.selectPaging(
  'users',
  {
    where: { companyId: 1 },
    include: { roles: true }
  },
  0,    // skip (offset)
  10,   // limit (take)
  { createdAt: 'desc' } // ordenação
);

// Retorna:
// {
//   total: 50,  // total de registros
//   rows: [...]  // registros da página atual
// }
```

### 5. insert()
Cria um novo registro com log automático opcional.

```typescript
// Criar novo usuário COM log de auditoria
const newUser = await prismaService.insert(
  'users',
  {
    name: 'João Silva',
    email: 'joao@example.com',
    companyId: 1,
    active: true
  },
  {
    companyId: 1,  // Para o log
    userId: currentUserId  // Usuário que está criando
  }
);

// Criar novo usuário SEM log de auditoria
const newUser = await prismaService.insert(
  'users',
  {
    name: 'João Silva',
    email: 'joao@example.com',
    companyId: 1,
    active: true
  }
  // logParams omitido - não registra log
);
```

### 6. bulkInsert()
Insere múltiplos registros de uma vez.

```typescript
// Criar múltiplos registros
const result = await prismaService.bulkInsert(
  'products',
  [
    { name: 'Produto 1', price: 100 },
    { name: 'Produto 2', price: 200 },
    { name: 'Produto 3', price: 300 }
  ]
);
```

⚠️ **Atenção**: `bulkInsert` não registra logs individuais devido às limitações do Prisma.

### 7. update()
Atualiza um registro existente com log de mudanças opcional.

```typescript
// Atualizar por ID COM log
const updated = await prismaService.update(
  'users',
  { 
    name: 'João Silva Atualizado',
    email: 'novo-email@example.com'
  },
  {
    companyId: 1,
    userId: currentUserId
  },
  null,  // params adicionais (opcional)
  1      // ID do registro
);

// Atualizar SEM log
const updated = await prismaService.update(
  'users',
  { active: false },
  null,  // logParams omitido
  {
    where: { 
      email: 'user@example.com' 
    }
  }
);
```

### 8. selectOrCreate()
Busca um registro ou cria se não existir, com log opcional.

```typescript
// Buscar ou criar categoria COM log
const result = await prismaService.selectOrCreate(
  'categories',
  { name: 'Eletrônicos' },  // condição de busca
  {                          // dados para criar se não existir
    name: 'Eletrônicos',
    description: 'Produtos eletrônicos',
    active: true
  },
  {
    companyId: 1,
    userId: currentUserId
  }
);

// Buscar ou criar SEM log
const result = await prismaService.selectOrCreate(
  'categories',
  { name: 'Eletrônicos' },
  {
    name: 'Eletrônicos',
    description: 'Produtos eletrônicos',
    active: true
  }
  // logParams omitido
);

// Retorna:
// {
//   data: {...},      // registro encontrado ou criado
//   created: boolean  // true se foi criado, false se já existia
// }
```

### 9. upsert()
Cria ou atualiza um registro baseado em condições únicas, com log opcional.

```typescript
// Criar ou atualizar configuração COM log
await prismaService.upsert(
  'settings',
  {
    key: 'max_users',
    value: '100',
    description: 'Máximo de usuários permitidos'
  },
  {
    where: { key: 'max_users' }
  },
  {
    companyId: 1,
    userId: currentUserId
  }
);

// Criar ou atualizar SEM log
await prismaService.upsert(
  'settings',
  {
    key: 'max_users',
    value: '100',
    description: 'Máximo de usuários permitidos'
  },
  {
    where: { key: 'max_users' }
  }
  // logParams omitido
);
```

### 10. erase()
Remove um registro (soft delete por padrão), com log opcional.

```typescript
// Soft delete COM log
await prismaService.erase(
  'users',
  { where: { id: 1 } },
  {
    companyId: 1,
    userId: currentUserId
  }
);

// Soft delete SEM log
await prismaService.erase(
  'users',
  { where: { id: 1 } }
  // logParams omitido
);

// Hard delete (exclusão permanente) COM log
await prismaService.erase(
  'users',
  { where: { id: 1 } },
  {
    companyId: 1,
    userId: currentUserId
  },
  false  // virtual = false para hard delete
);
```

**Campos suportados para Soft Delete:**
- `inactiveAt`: Define a data de inativação
- `deletedAt`: Define a data de exclusão
- `active`: Define como `false`
- `status`: Define como `false`

### 11. makeTransactions()
Executa múltiplas operações em uma transação.

```typescript
// Executar múltiplas operações atomicamente
await prismaService.makeTransactions([
  async (tx) => {
    // Criar pedido
    const order = await prismaService.insert(
      'orders',
      { 
        userId: 1, 
        total: 500 
      },
      { companyId: 1, userId: 1 },
      tx  // passar a transação
    );
    
    // Atualizar estoque
    await prismaService.update(
      'products',
      { stock: { decrement: 1 } },
      { companyId: 1, userId: 1 },
      { where: { id: productId } },
      null,
      tx  // usar a mesma transação
    );
    
    // Se qualquer operação falhar, todas são revertidas
  }
]);
```

## Sistema de Logs

Todas as operações que modificam dados podem ser registradas na tabela `system_Logs` quando `logParams` é fornecido:

### Estrutura do Log

```typescript
{
  companyId: number,      // Empresa relacionada
  userId: number,         // Usuário que executou a ação
  action: string,         // 'create', 'update', 'delete', 'soft_delete'
  entity: string,         // Nome da tabela/modelo
  entityId: number,       // ID do registro afetado
  column: string | null,  // Coluna modificada (para updates)
  oldValue: string,       // Valor anterior (JSON)
  newValue: string,       // Novo valor (JSON)
  createdAt: Date         // Timestamp automático
}
```

### Exemplo de Logs Gerados

```typescript
// INSERT gera 1 log:
{
  action: 'create',
  entity: 'users',
  entityId: 1,
  newValue: '{"name":"João","email":"joao@example.com"}'
}

// UPDATE gera 1 log por campo alterado:
{
  action: 'update',
  entity: 'users',
  entityId: 1,
  column: 'email',
  oldValue: '"joao@example.com"',
  newValue: '"novo-email@example.com"'
}

// SOFT DELETE gera 1 log:
{
  action: 'soft_delete',
  entity: 'users',
  entityId: 1,
  column: 'inactiveAt',
  newValue: '"2024-01-15T10:30:00.000Z"'
}

// HARD DELETE gera 1 log:
{
  action: 'delete',
  entity: 'users',
  entityId: 1,
  oldValue: '{"id":1,"name":"João",...}',
  newValue: null
}
```

## Uso em Services do NestJS

### Exemplo Completo de Service

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

  // Listar com paginação
  async findAll(page: number, limit: number, companyId: number) {
    return this.prisma.selectPaging(
      'users',
      {
        where: { 
          companyId,
          active: true 
        },
        include: {
          roles: true,
          company: true
        }
      },
      (page - 1) * limit,
      limit,
      { createdAt: 'desc' }
    );
  }

  // Buscar por ID
  async findOne(id: number) {
    return this.prisma.selectOne('users', {
      where: { id },
      include: {
        roles: true,
        company: true
      }
    });
  }

  // Criar
  async create(data: CreateUserDto, currentUser: any) {
    return this.prisma.insert(
      'users',
      data,
      {
        companyId: currentUser.companyId,
        userId: currentUser.id
      }
    );
  }

  // Atualizar
  async update(id: number, data: UpdateUserDto, currentUser: any) {
    return this.prisma.update(
      'users',
      data,
      {
        companyId: currentUser.companyId,
        userId: currentUser.id
      },
      null,
      id
    );
  }

  // Soft Delete
  async remove(id: number, currentUser: any) {
    return this.prisma.erase(
      'users',
      { where: { id } },
      {
        companyId: currentUser.companyId,
        userId: currentUser.id
      }
    );
  }

  // Operação complexa com transação
  async transferUserToCompany(
    userId: number, 
    newCompanyId: number, 
    currentUser: any
  ) {
    return this.prisma.makeTransactions([
      async (tx) => {
        // Atualizar usuário
        await this.prisma.update(
          'users',
          { companyId: newCompanyId },
          {
            companyId: currentUser.companyId,
            userId: currentUser.id
          },
          null,
          userId,
          tx
        );

        // Remover roles antigas
        await this.prisma.erase(
          'userRoles',
          { 
            where: { 
              userId,
              companyId: currentUser.companyId 
            } 
          },
          {
            companyId: currentUser.companyId,
            userId: currentUser.id
          },
          false,  // hard delete
          tx
        );

        // Adicionar role padrão na nova empresa
        await this.prisma.insert(
          'userRoles',
          {
            userId,
            roleId: 1,  // Role padrão
            companyId: newCompanyId
          },
          {
            companyId: newCompanyId,
            userId: currentUser.id
          },
          tx
        );
      }
    ]);
  }
}
```

## Boas Práticas

### 1. Sempre Use Transações para Operações Relacionadas

```typescript
// ✅ BOM: Usa transação
await prisma.makeTransactions([
  async (tx) => {
    await prisma.insert('orders', orderData, logParams, tx);
    await prisma.update('inventory', stockData, logParams, null, productId, tx);
  }
]);

// ❌ RUIM: Sem transação
await prisma.insert('orders', orderData, logParams);
await prisma.update('inventory', stockData, logParams, null, productId);
```

### 2. Use logParams para Auditoria

```typescript
// ✅ COM AUDITORIA: Registra logs de todas as operações
await prisma.insert('products', data, {
  companyId: user.companyId,
  userId: user.id
});

// ✅ SEM AUDITORIA: Não registra logs (útil para migrações, seeds, etc)
await prisma.insert('products', data);

// Decisão baseada no contexto:
// - APIs de usuário: sempre use logParams
// - Scripts de migração: omita logParams
// - Processamento em lote: considere performance vs auditoria
```

### 3. Use Soft Delete por Padrão

```typescript
// ✅ BOM: Soft delete preserva dados
await prisma.erase('users', { where: { id } }, logParams);

// ⚠️ CUIDADO: Hard delete é irreversível
await prisma.erase('users', { where: { id } }, logParams, false);
```

### 4. Aproveite selectOrCreate para Evitar Duplicatas

```typescript
// ✅ BOM: Garante unicidade
const { data, created } = await prisma.selectOrCreate(
  'tags',
  { name: tagName },
  { name: tagName, slug: slugify(tagName) },
  logParams
);

// ❌ RUIM: Pode criar duplicatas
const existing = await prisma.selectFirst('tags', { where: { name: tagName } });
if (!existing) {
  await prisma.insert('tags', { name: tagName }, logParams);
}
```

### 5. Use Tipos do Prisma

```typescript
import { Prisma } from '@prisma/client';

// Use tipos gerados para where conditions
const whereCondition: Prisma.UsersWhereInput = {
  companyId: 1,
  active: true,
  email: { contains: '@example.com' }
};

const users = await prisma.select('users', { where: whereCondition });
```

## Tratamento de Erros

Todos os métodos lançam `BadRequestException` em caso de erro:

```typescript
try {
  const user = await prisma.insert('users', userData, logParams);
} catch (error) {
  // error será uma BadRequestException com detalhes do erro do Prisma
  console.error('Erro ao criar usuário:', error.message);
}
```

## Debugging

### Habilitar Logs SQL

```bash
# .env
LOGS_DB=true
```

Com logs habilitados, você verá no console:
- Queries SQL executadas
- Tempo de execução
- Parâmetros das queries
- Avisos e erros

### Verificar Logs de Auditoria

```sql
-- Ver últimas operações
SELECT * FROM system_Logs 
ORDER BY createdAt DESC 
LIMIT 50;

-- Ver operações de um usuário específico
SELECT * FROM system_Logs 
WHERE userId = 1 
ORDER BY createdAt DESC;

-- Ver mudanças em uma entidade específica
SELECT * FROM system_Logs 
WHERE entity = 'users' AND entityId = 1 
ORDER BY createdAt DESC;
```

## Limitações Conhecidas

1. **bulkInsert não gera logs detalhados**: O método `createMany` do Prisma não retorna os registros criados, impossibilitando o log individual.

2. **Soft Delete requer campos específicos**: A tabela deve ter ao menos um dos campos: `inactiveAt`, `deletedAt`, `active` ou `status`.

3. **Logs podem falhar silenciosamente**: Para não interromper operações principais, erros de log são apenas logados no console.

4. **Logs são opcionais**: Desde a última atualização, `logParams` é opcional em todos os métodos de modificação. Omitir `logParams` desativa completamente o registro de logs para aquela operação.

## Migração de Código Existente

### De Prisma Client Nativo

```typescript
// Antes (Prisma nativo)
const user = await prisma.users.findUnique({
  where: { id: 1 }
});

// Depois (PrismaService)
const user = await prismaService.selectOne('users', {
  where: { id: 1 }
});
```

### Adicionando Logs a Código Existente

```typescript
// Antes (sem logs)
const user = await prisma.users.create({
  data: userData
});

// Depois (com logs automáticos)
const user = await prismaService.insert(
  'users',
  userData,
  {
    companyId: currentUser.companyId,
    userId: currentUser.id
  }
);

// Ou sem logs quando não necessário
const user = await prismaService.insert(
  'users',
  userData
);
```

## Conclusão

O `PrismaService` fornece uma camada de abstração poderosa sobre o Prisma Client, adicionando funcionalidades essenciais para aplicações empresariais como auditoria automática, soft delete e transações simplificadas. Use esta documentação como referência para implementar operações de banco de dados de forma consistente e segura em toda a aplicação.