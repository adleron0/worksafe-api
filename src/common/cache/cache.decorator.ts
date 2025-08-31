import { SetMetadata } from '@nestjs/common';
import { applyDecorators, UseInterceptors } from '@nestjs/common';
import { CacheInterceptor } from './cache.interceptor';

export const CACHE_KEY_METADATA = 'cache:key';
export const CACHE_TTL_METADATA = 'cache:ttl';
export const CACHE_PREFIX_METADATA = 'cache:prefix';

export interface CacheOptions {
  prefix?: string; // Prefixo para a chave do cache
  ttl?: number; // TTL em segundos
  key?: string | ((req: any) => string); // Chave customizada
}

/**
 * Decorator de cache robusto e adaptativo
 *
 * Exemplos de uso:
 *
 * @Cache() // Cache padrão com TTL de 5 minutos
 * @Cache({ ttl: 3600 }) // Cache de 1 horaem segundos
 * @Cache({ prefix: 'products', ttl: 172800 }) // Cache de 48h em segundos
 * @Cache({ key: (req) => `user:${req.user.id}` }) // Chave dinâmica
 */
export function Cache(options: CacheOptions = {}) {
  const ttl = options.ttl || 300; // 5 minutos padrão
  const prefix = options.prefix || '';
  const key = options.key || null;

  return applyDecorators(
    SetMetadata(CACHE_TTL_METADATA, ttl),
    SetMetadata(CACHE_PREFIX_METADATA, prefix),
    SetMetadata(CACHE_KEY_METADATA, key),
    UseInterceptors(CacheInterceptor),
  );
}

/**
 * Decorator para invalidar cache
 *
 * @param pattern - Padrão para invalidar (ex: 'products:*') ou função que gera o padrão
 */
export function CacheEvict(
  pattern: string | ((args: any[]) => string),
): MethodDecorator {
  return (
    target: any,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      // Executar o método original primeiro
      const result = await originalMethod.apply(this, args);

      // Depois invalidar o cache
      try {
        const cacheService = (this as any).cacheService;
        if (cacheService) {
          const patternToEvict =
            typeof pattern === 'function' ? pattern(args) : pattern;
          await cacheService.reset(patternToEvict);
          console.log(`Cache evicted: ${patternToEvict}`);
        }
      } catch (error) {
        console.error('Cache eviction error:', error);
      }

      return result;
    };

    return descriptor;
  };
}

/**
 * Decorator para invalidar múltiplos padrões de cache
 */
export function CacheEvictAll(...patterns: string[]): MethodDecorator {
  return (
    target: any,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const originalMethod = descriptor.value;
    const isAsync = originalMethod.constructor.name === 'AsyncFunction';

    if (isAsync) {
      descriptor.value = async function (...args: any[]) {
        // Invalidar o cache ANTES de executar o método
        try {
          const cacheService = (this as any).cacheService;
          if (cacheService) {
            await Promise.all(
              patterns.map((pattern) => cacheService.reset(pattern)),
            );
            console.log(
              `Cache evicted BEFORE execution: ${patterns.join(', ')}`,
            );
          }
        } catch (error) {
          console.error('Cache eviction error:', error);
        }

        // Executar o método original preservando o contexto
        const result = await originalMethod.call(this, ...args);

        // Invalidar novamente DEPOIS para garantir
        try {
          const cacheService = (this as any).cacheService;
          if (cacheService) {
            await Promise.all(
              patterns.map((pattern) => cacheService.reset(pattern)),
            );
            console.log(
              `Cache evicted AFTER execution: ${patterns.join(', ')}`,
            );
          }
        } catch (error) {
          console.error('Cache eviction error:', error);
        }

        return result;
      };
    } else {
      descriptor.value = function (...args: any[]) {
        // Versão síncrona (se houver)
        const result = originalMethod.call(this, ...args);

        // Tentar invalidar cache de forma assíncrona
        const cacheService = (this as any).cacheService;
        if (cacheService) {
          Promise.all(patterns.map((pattern) => cacheService.reset(pattern)))
            .then(() => {
              console.log(`Cache evicted: ${patterns.join(', ')}`);
            })
            .catch((error) => {
              console.error('Cache eviction error:', error);
            });
        }

        return result;
      };
    }

    // Preservar metadados do método original
    Object.setPrototypeOf(descriptor.value, originalMethod);
    Object.defineProperty(descriptor.value, 'name', {
      value: originalMethod.name,
    });

    return descriptor;
  };
}
