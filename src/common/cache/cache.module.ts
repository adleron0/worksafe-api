import { Module, Global } from '@nestjs/common';
import { CacheService } from '../services/cache.service';
import { CacheInterceptor } from './cache.interceptor';
import { AuthCacheService } from './auth-cache.service';

@Global()
@Module({
  providers: [CacheService, CacheInterceptor, AuthCacheService],
  exports: [CacheService, CacheInterceptor, AuthCacheService],
})
export class CacheModule {}