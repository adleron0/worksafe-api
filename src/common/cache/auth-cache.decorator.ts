import { AuthCacheService } from './auth-cache.service';

/**
 * Decorator para invalidar cache de autenticação após operações que afetam permissões
 */
export function InvalidateAuthCache(
  target: 'user' | 'users' | 'company' | 'profile',
  extractId?: (args: any[]) => number | number[],
): MethodDecorator {
  return (
    targetClass: any,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      // Executar o método original primeiro
      const result = await originalMethod.apply(this, args);

      // Depois invalidar o cache
      try {
        const authCache: AuthCacheService = (this as any).authCache;

        if (!authCache) {
          console.warn('AuthCacheService not found in instance');
          return result;
        }

        // Extrair IDs baseado no tipo de target
        const context: any = {};

        if (extractId) {
          const extracted = extractId(args);

          switch (target) {
            case 'user':
              context.userId = extracted as number;
              break;
            case 'users':
              context.userIds = extracted as number[];
              break;
            case 'company':
              context.companyId = extracted as number;
              break;
            case 'profile':
              context.profileId = extracted as number;
              break;
          }
        } else {
          // Tentar extrair automaticamente do resultado
          switch (target) {
            case 'user':
              context.userId = result?.id || args[0];
              break;
            case 'company':
              context.companyId = result?.companyId || result?.id;
              break;
            case 'profile':
              context.profileId = result?.profileId || result?.id;
              break;
          }
        }

        await authCache.smartInvalidate(context);
      } catch (error) {
        console.error('Auth cache invalidation error:', error);
      }

      return result;
    };

    return descriptor;
  };
}
