import { Injectable } from '@nestjs/common';
import { CacheService } from './cache.service';

@Injectable()
export class RedisTestService {
  constructor(private readonly cacheService: CacheService) {}

  async testConnection() {
    console.log('=== Redis Connection Test ===');
    console.log('REDIS_URL:', process.env.REDIS_URL ? 'Set (hidden)' : 'Not set');
    console.log('REDIS_HOST:', process.env.REDIS_HOST);
    console.log('NODE_ENV:', process.env.NODE_ENV);
    
    try {
      await this.cacheService.set('test-key', 'test-value', 10);
      const value = await this.cacheService.get('test-key');
      
      return {
        status: 'connected',
        test: value === 'test-value' ? 'passed' : 'failed',
        value,
        config: {
          hasRedisUrl: !!process.env.REDIS_URL,
          hasRedisHost: !!process.env.REDIS_HOST,
          nodeEnv: process.env.NODE_ENV,
        }
      };
    } catch (error) {
      return {
        status: 'error',
        message: error.message,
        config: {
          hasRedisUrl: !!process.env.REDIS_URL,
          hasRedisHost: !!process.env.REDIS_HOST,
          nodeEnv: process.env.NODE_ENV,
        }
      };
    }
  }
}