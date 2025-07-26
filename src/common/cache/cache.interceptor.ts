import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Inject,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Reflector } from '@nestjs/core';
import { CacheService } from '../services/cache.service';
import {
  CACHE_KEY_METADATA,
  CACHE_TTL_METADATA,
  CACHE_PREFIX_METADATA,
} from './cache.decorator';

@Injectable()
export class CacheInterceptor implements NestInterceptor {
  constructor(
    @Inject(CacheService) private cacheService: CacheService,
    private reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const handler = context.getHandler();
    
    // Apenas fazer cache de requisições GET
    if (request.method !== 'GET') {
      return next.handle();
    }

    // Obter metadados do decorator
    const ttl = this.reflector.get<number>(CACHE_TTL_METADATA, handler) || 300;
    const prefix = this.reflector.get<string>(CACHE_PREFIX_METADATA, handler) || '';
    const customKey = this.reflector.get<string | Function>(CACHE_KEY_METADATA, handler);

    // Gerar chave de cache
    const cacheKey = this.generateCacheKey(request, prefix, customKey);

    try {
      // Tentar buscar do cache
      const cached = await this.cacheService.get(cacheKey);
      if (cached) {
        console.log(`Cache hit: ${cacheKey}`);
        // Adicionar header para indicar que veio do cache
        response.setHeader('X-Cache', 'HIT');
        return of(cached);
      }
    } catch (error) {
      console.error('Cache error:', error);
    }

    // Se não tem cache, executar e salvar
    // Definir header antes de enviar a resposta
    response.setHeader('X-Cache', 'MISS');
    
    return next.handle().pipe(
      tap(async (data) => {
        try {
          // Apenas cachear respostas bem-sucedidas
          if (response.statusCode >= 200 && response.statusCode < 300) {
            await this.cacheService.set(cacheKey, data, ttl);
            console.log(`Cache set: ${cacheKey} (TTL: ${ttl}s)`);
          }
        } catch (error) {
          console.error('Cache save error:', error);
        }
      }),
    );
  }

  private generateCacheKey(
    request: any,
    prefix: string,
    customKey?: string | Function,
  ): string {
    // Se tem chave customizada
    if (customKey) {
      if (typeof customKey === 'function') {
        return customKey(request);
      }
      return customKey;
    }

    // Gerar chave baseada na URL e query
    const { url, path, query } = request;
    const queryStr = query && Object.keys(query).length > 0
      ? `:${this.serializeQuery(query)}`
      : '';

    // Se tem prefixo, usar ele
    if (prefix) {
      return `${prefix}${queryStr || ':all'}`;
    }

    // Senão, usar a URL completa
    return `cache:${url}`;
  }

  private serializeQuery(query: any): string {
    // Ordenar as chaves para garantir consistência
    const sortedKeys = Object.keys(query).sort();
    const pairs = sortedKeys
      .filter(key => query[key] !== undefined && query[key] !== null)
      .map(key => `${key}=${query[key]}`);
    
    return pairs.join('&');
  }
}