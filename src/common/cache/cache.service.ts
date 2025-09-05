import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class CacheService implements OnModuleDestroy, OnModuleInit {
  private redis: Redis;

  constructor() {
    const isProduction = process.env.NODE_ENV === 'production';

    // Suporta tanto REDIS_URL quanto configurações individuais
    if (process.env.REDIS_URL) {
      console.log('Connecting to Redis using REDIS_URL');

      // Se a URL contém railway.internal, precisa de configuração especial
      if (process.env.REDIS_URL.includes('railway.internal')) {
        // Parse da URL para extrair host, porta e senha
        const url = new URL(process.env.REDIS_URL);
        this.redis = new Redis({
          host: url.hostname,
          port: parseInt(url.port || '6379'),
          password: url.password,
          family: 6, // Força IPv6 para Railway internal
          retryStrategy: (times: number) => {
            const delay = Math.min(times * 50, 2000);
            return delay;
          },
          connectTimeout: 10000,
          commandTimeout: 5000,
        });
      } else {
        // URL normal (externa)
        this.redis = new Redis(process.env.REDIS_URL, {
          retryStrategy: (times: number) => {
            const delay = Math.min(times * 50, 2000);
            return delay;
          },
          reconnectOnError: (err) => {
            const targetError = 'READONLY';
            if (err.message.includes(targetError)) {
              return true;
            }
            return false;
          },
          connectTimeout: 10000,
          commandTimeout: 5000,
        });
      }
    } else {
      // Configuração individual para desenvolvimento ou outros ambientes
      this.redis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB || '0'),
        // Configurações de SSL para produção
        ...(isProduction && process.env.REDIS_TLS === 'true'
          ? {
              tls: {
                rejectUnauthorized: false,
              },
            }
          : {}),
        retryStrategy: (times: number) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        reconnectOnError: (err) => {
          const targetError = 'READONLY';
          if (err.message.includes(targetError)) {
            return true;
          }
          return false;
        },
        // Timeout para evitar travamentos
        connectTimeout: 10000,
        commandTimeout: 5000,
      });
    }

    this.redis.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });

    this.redis.on('connect', () => {
      console.log('Redis Client Connected');
    });
  }

  async get<T = any>(key: string): Promise<T | null> {
    try {
      const value = await this.redis.get(key);
      if (!value) return null;

      return JSON.parse(value);
    } catch (error) {
      console.error(`Error getting cache key ${key}:`, error);
      return null;
    }
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);

      if (ttl) {
        await this.redis.setex(key, ttl, serialized);
      } else {
        await this.redis.set(key, serialized);
      }
    } catch (error) {
      console.error(`Error setting cache key ${key}:`, error);
      throw error;
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (error) {
      console.error(`Error deleting cache key ${key}:`, error);
      throw error;
    }
  }

  async reset(pattern?: string): Promise<void> {
    try {
      if (pattern) {
        const keys = await this.redis.keys(pattern);
        console.log(
          `Found ${keys.length} keys matching pattern "${pattern}":`,
          keys,
        );
        if (keys.length > 0) {
          await this.redis.del(...keys);
          console.log(`Deleted ${keys.length} cache keys`);
        }
      } else {
        await this.redis.flushdb();
      }
    } catch (error) {
      console.error('Error resetting cache:', error);
      throw error;
    }
  }

  async keys(pattern: string): Promise<string[]> {
    try {
      return await this.redis.keys(pattern);
    } catch (error) {
      console.error(`Error getting keys with pattern ${pattern}:`, error);
      return [];
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      return await this.redis.ttl(key);
    } catch (error) {
      console.error(`Error getting TTL for key ${key}:`, error);
      return -1;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.redis.exists(key);
      return result === 1;
    } catch (error) {
      console.error(`Error checking existence of key ${key}:`, error);
      return false;
    }
  }

  // Método para operações atômicas
  async increment(key: string, ttl?: number): Promise<number> {
    try {
      const result = await this.redis.incr(key);
      if (ttl) {
        await this.redis.expire(key, ttl);
      }
      return result;
    } catch (error) {
      console.error(`Error incrementing key ${key}:`, error);
      throw error;
    }
  }

  // Método para hash operations
  async hset(key: string, field: string, value: any): Promise<void> {
    try {
      await this.redis.hset(key, field, JSON.stringify(value));
    } catch (error) {
      console.error(`Error setting hash field ${field} in key ${key}:`, error);
      throw error;
    }
  }

  async hget<T = any>(key: string, field: string): Promise<T | null> {
    try {
      const value = await this.redis.hget(key, field);
      if (!value) return null;

      return JSON.parse(value);
    } catch (error) {
      console.error(
        `Error getting hash field ${field} from key ${key}:`,
        error,
      );
      return null;
    }
  }

  async hgetall<T = any>(key: string): Promise<Record<string, T>> {
    try {
      const hash = await this.redis.hgetall(key);
      const result: Record<string, T> = {};

      for (const [field, value] of Object.entries(hash)) {
        result[field] = JSON.parse(value);
      }

      return result;
    } catch (error) {
      console.error(`Error getting all hash fields from key ${key}:`, error);
      return {};
    }
  }

  async onModuleInit() {
    // Sempre limpa todo o cache Redis ao iniciar a aplicação
    try {
      // Primeiro obtém informações do cache antes de limpar
      const keyCountBefore = await this.redis.dbsize();
      const infoBefore = await this.redis.info('memory');
      const memoryBefore =
        infoBefore.match(/used_memory_human:(.+)/)?.[1]?.trim() || 'N/A';

      console.log('═══════════════════════════════════════════════════');
      console.log('🔄 LIMPEZA DE CACHE REDIS NA INICIALIZAÇÃO');
      console.log('═══════════════════════════════════════════════════');
      console.log(`📊 Estado anterior do cache:`);
      console.log(`   - Total de chaves: ${keyCountBefore}`);
      console.log(`   - Memória utilizada: ${memoryBefore}`);
      console.log('───────────────────────────────────────────────────');
      console.log('🗑️  Executando limpeza completa do Redis...');

      await this.redis.flushall();

      // Verifica se limpou corretamente
      const keyCountAfter = await this.redis.dbsize();

      console.log('✅ CACHE REDIS LIMPO COM SUCESSO!');
      console.log(`📊 Estado atual do cache:`);
      console.log(`   - Total de chaves: ${keyCountAfter}`);
      console.log(`   - Chaves removidas: ${keyCountBefore}`);
      console.log('═══════════════════════════════════════════════════');
      console.log('');
    } catch (error) {
      console.error('═══════════════════════════════════════════════════');
      console.error('❌ ERRO AO LIMPAR CACHE REDIS NA INICIALIZAÇÃO');
      console.error('═══════════════════════════════════════════════════');
      console.error('Detalhes do erro:', error);
      console.error('═══════════════════════════════════════════════════');
      console.error('');
    }
  }

  async clearAllCache(): Promise<void> {
    try {
      console.log('🔄 Limpando todo o cache Redis...');
      await this.redis.flushall();
      console.log('✅ Cache Redis limpo com sucesso!');
    } catch (error) {
      console.error('❌ Erro ao limpar cache Redis:', error);
      throw error;
    }
  }

  async getCacheInfo(): Promise<{ keyCount: number; memoryUsage: string }> {
    try {
      const keyCount = await this.redis.dbsize();
      const info = await this.redis.info('memory');
      const memoryUsed = info.match(/used_memory_human:(.+)/)?.[1] || 'N/A';

      return {
        keyCount,
        memoryUsage: memoryUsed.trim(),
      };
    } catch (error) {
      console.error('❌ Erro ao obter informações do cache:', error);
      return { keyCount: 0, memoryUsage: 'N/A' };
    }
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }
}
