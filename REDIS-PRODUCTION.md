# Configuração do Redis em Produção

## Railway.app

### 1. No Railway, crie o serviço Redis

1. Adicione um novo serviço Redis no seu projeto
2. O Railway criará automaticamente a variável `REDIS_URL`

### 2. Configure a variável no seu serviço Node.js

No painel do Railway, no seu serviço da API:

1. Vá em **Variables**
2. Adicione uma nova variável:
   - **Nome**: `REDIS_URL`
   - **Valor**: `${{ Redis.REDIS_URL }}`
3. **Deploy** o serviço

### 3. Configuração do .env

```env
# Desenvolvimento (local)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# Produção (Railway) - apenas isso!
REDIS_URL=${{ Redis.REDIS_URL }}
```

## Outras Plataformas

### Heroku
```env
# Heroku Redis adiciona automaticamente
REDIS_URL=redis://:password@host:port
```

### Render.com
```env
# Render fornece a URL completa
REDIS_URL=redis://red-abc123:6379
```

### Digital Ocean
```env
REDIS_URL=rediss://default:password@db-redis-nyc1-12345.b.db.ondigitalocean.com:25061
```

### AWS ElastiCache
```env
# ElastiCache não usa URL, use configuração individual
REDIS_HOST=meu-cluster.abc123.ng.0001.use1.cache.amazonaws.com
REDIS_PORT=6379
REDIS_TLS=true
```

## Como o Código Funciona

O `CacheService` detecta automaticamente qual configuração usar:

```typescript
if (process.env.REDIS_URL) {
  // Usa REDIS_URL (Railway, Heroku, etc)
  this.redis = new Redis(process.env.REDIS_URL);
} else {
  // Usa configuração individual (desenvolvimento)
  this.redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    // etc...
  });
}
```

## Verificar Conexão

Adicione este endpoint temporário para testar:

```typescript
@Get('test/redis')
async testRedis() {
  try {
    await this.cacheService.set('test', 'OK', 5);
    const value = await this.cacheService.get('test');
    return { 
      status: 'connected', 
      test: value,
      url: process.env.REDIS_URL ? 'Using REDIS_URL' : 'Using individual config'
    };
  } catch (error) {
    return { 
      status: 'error', 
      message: error.message 
    };
  }
}
```

## Variáveis de Ambiente Finais

### Para Railway (recomendado):
```env
NODE_ENV=production
REDIS_URL=${{ Redis.REDIS_URL }}
```

### Para desenvolvimento:
```env
NODE_ENV=development
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
```

## Troubleshooting

### Erro: "Redis connection failed"
- Verifique se a variável `REDIS_URL` está configurada no Railway
- Confirme que o serviço Redis está rodando

### Erro: "ECONNREFUSED"
- Em desenvolvimento: inicie o Redis local
- Em produção: verifique a URL de conexão

### Performance lenta
- Verifique a região do Redis (deve ser próxima ao servidor)
- Monitore o uso de memória no Redis

## Segurança

1. **Nunca commite** `REDIS_URL` no código
2. Use sempre variáveis de ambiente
3. Em produção, o Redis deve ter senha
4. Configure timeouts para evitar travamentos