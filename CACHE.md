# Sistema de Cache - WorkSafe API

## Visão Geral

O sistema de cache foi implementado usando Redis para melhorar a performance e reduzir a carga no banco de dados. O cache é aplicado automaticamente em rotas GET e invalidado em operações de escrita (POST, PUT, PATCH).

## Instalação

As dependências já estão instaladas no projeto:
- `ioredis` - Cliente Redis para Node.js
- `cache-manager` - Gerenciador de cache
- `cache-manager-ioredis-yet` - Adapter Redis para cache-manager

## Configuração

### 1. Variáveis de Ambiente

Adicione no arquivo `.env`:

```env
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
```

### 2. Iniciando o Redis

```bash
# macOS
brew services start redis

# Linux
sudo systemctl start redis

# Docker
docker run -d -p 6379:6379 redis
```

## Como Usar

### Cache em Rotas GET

Use o decorator `@Cache()` em qualquer método GET:

```typescript
import { Cache } from 'src/common/cache';

@Controller('products')
export class ProductController {
  
  // Cache padrão de 5 minutos
  @Cache()
  @Get()
  findAll() {
    return this.service.findAll();
  }

  // Cache personalizado de 1 hora
  @Cache({ ttl: 3600 })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  // Cache com prefixo customizado (48 horas)
  @Cache({ prefix: 'site-products', ttl: 172800 })
  @Get('public/list')
  publicList() {
    return this.service.getPublicProducts();
  }
}
```

### Invalidação de Cache

Use os decorators de invalidação em métodos que modificam dados:

```typescript
import { Cache, CacheEvictAll } from 'src/common/cache';

@Controller('products')
export class ProductController {
  
  // Invalida todo cache de produtos ao criar
  @CacheEvictAll('site-products:*')
  @Post()
  create(@Body() dto: CreateProductDto) {
    return this.service.create(dto);
  }

  // Invalida múltiplos padrões de cache
  @CacheEvictAll('site-products:*', 'cache:*/products*')
  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.service.update(id, dto);
  }
}
```

## Exemplos Práticos

### 1. Cache Simples

```typescript
@Public()
@Cache({ prefix: 'site-services', ttl: 172800 }) // 48 horas
@Get()
async getServices() {
  return this.service.findAll();
}
```

### 2. Cache com Invalidação

```typescript
// GET - Com cache
@Cache({ prefix: 'products', ttl: 3600 })
@Get()
async list() {
  return this.service.findAll();
}

// POST - Invalida o cache
@CacheEvictAll('products:*')
@Post()
async create(@Body() dto: CreateDto) {
  return this.service.create(dto);
}
```

### 3. Múltiplas Invalidações

```typescript
// Invalida cache de produtos e imagens relacionadas
@CacheEvictAll('products:*', 'product-images:*', 'cache:*/products*')
@Delete(':id')
async delete(@Param('id') id: string) {
  return this.service.delete(id);
}
```

## Como Funciona

1. **Requisição GET**: 
   - Verifica se existe cache para a chave gerada
   - Se existir, retorna do cache (Cache HIT)
   - Se não, executa o método e salva no cache (Cache MISS)

2. **Chaves de Cache**:
   - Com prefixo: `prefix:query-params`
   - Sem prefixo: `cache:full-url`
   - Query params são ordenados para consistência

3. **Headers HTTP**:
   - `X-Cache: HIT` - Resposta veio do cache
   - `X-Cache: MISS` - Resposta foi processada e salva no cache

## Monitoramento

Verifique os logs do servidor para acompanhar o cache:

```
Cache hit: site-products:active=true&limit=10
Cache set: site-products:active=true&limit=10 (TTL: 172800s)
Cache evicted: site-products:*
```

## Comandos Úteis

```bash
# Verificar se Redis está rodando
redis-cli ping

# Limpar todo o cache
redis-cli FLUSHDB

# Ver todas as chaves
redis-cli KEYS "*"

# Ver valor de uma chave
redis-cli GET "site-products:all"
```

## Boas Práticas

1. **TTL Apropriado**: Use TTL maior para dados que mudam pouco
2. **Prefixos Descritivos**: Use prefixos que identifiquem o recurso
3. **Invalidação Correta**: Sempre invalide o cache ao modificar dados
4. **Monitoramento**: Acompanhe logs para otimizar TTL e padrões

## Troubleshooting

### Redis não conecta
- Verifique se o Redis está rodando: `redis-cli ping`
- Confirme as variáveis de ambiente
- Verifique logs de erro no console

### Cache não funciona
- Confirme que o decorator está em método GET
- Verifique se o CacheService está injetado no controller
- Veja os logs para mensagens de erro

### Headers de cache não aparecem
- Use ferramentas como Postman ou DevTools do navegador
- Procure pelo header `X-Cache` na resposta