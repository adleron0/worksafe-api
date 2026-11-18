import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { decryptPayload, encryptPayload } from 'src/utils/crypto';

/** Variável do servidor de cada fornecedor (vale quando não há chave cadastrada na tela). */
export const PROVIDER_ENV_KEYS: Record<string, string> = {
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

export type KeySource = 'tela' | 'servidor' | null;

const REFRESH_MS = 60_000;

/**
 * Chaves dos fornecedores de IA cadastradas pela tela. A chave da tela tem
 * prioridade; sem ela vale a variável do servidor. Os fornecedores leem a chave
 * a cada chamada (de forma síncrona), por isso as chaves ficam em memória e são
 * recarregadas do banco a cada minuto (para valer também se houver mais de uma
 * instância da API).
 */
@Injectable()
export class ProviderKeyStore implements OnModuleInit {
  private readonly logger = new Logger(ProviderKeyStore.name);
  private cache = new Map<string, string>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.reload();
  }

  async reload(): Promise<void> {
    try {
      const rows = await this.prisma.ai_ProviderKey.findMany();
      const next = new Map<string, string>();
      for (const row of rows) {
        try {
          const key = decryptPayload(row.keyEncrypted);
          if (typeof key === 'string' && key) next.set(row.provider, key);
        } catch {
          this.logger.warn(`Chave de ${row.provider} não pôde ser lida (o segredo de criptografia mudou?)`);
        }
      }
      this.cache = next;
    } catch (error) {
      this.logger.warn(`Não foi possível carregar as chaves de IA: ${(error as Error).message}`);
    }
    this.loadedAt = Date.now();
  }

  /** Chave em uso para o fornecedor: a da tela ou, sem ela, a da variável do servidor. */
  key(provider: string): string {
    if (Date.now() - this.loadedAt > REFRESH_MS && !this.loading) {
      this.loading = this.reload().finally(() => { this.loading = null; });
    }
    const envName = PROVIDER_ENV_KEYS[provider];
    return this.cache.get(provider) || (envName ? process.env[envName] || '' : '');
  }

  source(provider: string): KeySource {
    if (this.cache.has(provider)) return 'tela';
    const envName = PROVIDER_ENV_KEYS[provider];
    return envName && process.env[envName] ? 'servidor' : null;
  }

  async list() {
    await this.reload();
    const rows = await this.prisma.ai_ProviderKey.findMany();
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    return Object.entries(PROVIDER_ENV_KEYS).map(([provider, envName]) => {
      const row = byProvider.get(provider);
      return {
        provider,
        envName,
        source: this.source(provider),
        hint: row && this.cache.has(provider) ? row.hint : null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  async set(provider: string, key: string, userId: number | null) {
    if (!PROVIDER_ENV_KEYS[provider]) throw new BadRequestException('Fornecedor de IA inválido');
    const hint = `…${key.slice(-4)}`;
    const keyEncrypted = encryptPayload(key);
    await this.prisma.ai_ProviderKey.upsert({
      where: { provider },
      create: { provider, keyEncrypted, hint, updatedByUserId: userId },
      update: { keyEncrypted, hint, updatedByUserId: userId },
    });
    this.cache.set(provider, key);
  }

  async remove(provider: string) {
    if (!PROVIDER_ENV_KEYS[provider]) throw new BadRequestException('Fornecedor de IA inválido');
    await this.prisma.ai_ProviderKey.deleteMany({ where: { provider } });
    this.cache.delete(provider);
  }
}
