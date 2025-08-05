import { Injectable } from '@nestjs/common';
import { CacheService } from '../services/cache.service';

@Injectable()
export class AuthCacheService {
  constructor(private readonly cacheService: CacheService) {}

  /**
   * Cache para dados do usuário com permissões
   * TTL: 1 hora - balanceando performance e segurança
   */
  async getUserWithPermissions(userId: number): Promise<any> {
    const key = `user:${userId}:permissions`;
    return this.cacheService.get(key);
  }

  async setUserWithPermissions(userId: number, userData: any): Promise<void> {
    const key = `user:${userId}:permissions`;
    await this.cacheService.set(key, userData, 3600); // 1 hora
  }

  /**
   * Cache para sessão de refresh token
   * TTL: 7 dias - mesmo tempo do refresh token
   */
  async getSession(userId: number, refreshToken: string): Promise<any> {
    const key = `session:${userId}:${refreshToken}`;
    return this.cacheService.get(key);
  }

  async setSession(
    userId: number,
    refreshToken: string,
    sessionData: any,
  ): Promise<void> {
    const key = `session:${userId}:${refreshToken}`;
    await this.cacheService.set(key, sessionData, 604800); // 7 dias
  }

  /**
   * Invalidação de cache para um usuário específico
   */
  async invalidateUserCache(userId: number): Promise<void> {
    // Invalida cache de permissões
    await this.cacheService.del(`user:${userId}:permissions`);

    // Invalida todas as sessões do usuário
    const sessionKeys = await this.cacheService.keys(`session:${userId}:*`);
    if (sessionKeys.length > 0) {
      await Promise.all(sessionKeys.map((key) => this.cacheService.del(key)));
    }

    console.log(`Cache invalidated for user ${userId}`);
  }

  /**
   * Invalidação de cache para múltiplos usuários (ex: ao mudar permissões de um perfil)
   */
  async invalidateMultipleUsersCache(userIds: number[]): Promise<void> {
    await Promise.all(
      userIds.map((userId) => this.invalidateUserCache(userId)),
    );
  }

  /**
   * Invalidação de cache por empresa (quando muda status da empresa)
   */
  async invalidateCompanyCache(companyId: number): Promise<void> {
    // Busca padrão de cache por empresa
    const userKeys = await this.cacheService.keys(`user:*:permissions`);

    // Para cada chave, verifica se pertence à empresa e invalida
    for (const key of userKeys) {
      const userData = await this.cacheService.get(key);
      if (userData?.companyId === companyId) {
        await this.cacheService.del(key);
      }
    }

    console.log(`Cache invalidated for company ${companyId}`);
  }

  /**
   * Método helper para invalidar cache baseado no contexto
   */
  async smartInvalidate(context: {
    userId?: number;
    userIds?: number[];
    companyId?: number;
    profileId?: number;
  }): Promise<void> {
    if (context.userId) {
      await this.invalidateUserCache(context.userId);
    }

    if (context.userIds && context.userIds.length > 0) {
      await this.invalidateMultipleUsersCache(context.userIds);
    }

    if (context.companyId) {
      await this.invalidateCompanyCache(context.companyId);
    }

    // Se mudou um perfil, invalida cache de todos os usuários com esse perfil
    if (context.profileId) {
      const userKeys = await this.cacheService.keys(`user:*:permissions`);
      for (const key of userKeys) {
        const userData = await this.cacheService.get(key);
        if (userData?.profile?.id === context.profileId) {
          await this.cacheService.del(key);
        }
      }
    }
  }
}
