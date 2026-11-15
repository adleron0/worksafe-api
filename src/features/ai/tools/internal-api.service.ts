import { Injectable } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import axios from 'axios';
import { encryptPayload } from 'src/utils/crypto';
import { ToolContext, ToolRefusal } from './tool.types';

/**
 * Chama as rotas do próprio sistema em nome da pessoa (token de 2 minutos com
 * as permissões dela). Assim as ferramentas reaproveitam tudo que a tela usa
 * — validação, regras do crud, cache, auditoria do sistema — sem copiar regra.
 * Erro 4xx vira recusa com o motivo, para o modelo corrigir.
 */
@Injectable()
export class InternalApiService {
  private readonly jwt = new JwtService();

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  private baseUrl(): string {
    const server = this.adapterHost.httpAdapter?.getHttpServer?.();
    const address = server?.address?.();
    const port = address && typeof address === 'object' ? address.port : Number(process.env.PORT) || 3000;
    return `http://127.0.0.1:${port}`;
  }

  private token(ctx: ToolContext): string {
    const payload = { sub: ctx.userId, companyId: ctx.companyId, permissions: ctx.permissions, profile: 'assistente', username: 'assistente' };
    return this.jwt.sign({ data: encryptPayload(payload) }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '2m' });
  }

  async call<T = any>(ctx: ToolContext, method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, options: { query?: Record<string, unknown>; body?: unknown } = {}): Promise<T> {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      params[key] = Array.isArray(value) ? value.join(',') : String(value);
    }
    const response = await axios.request({
      method, url: `${this.baseUrl()}/${path.replace(/^\//, '')}`, params, data: options.body,
      headers: { Authorization: `Bearer ${this.token(ctx)}`, 'Content-Type': 'application/json', 'X-Assistente': ctx.origin },
      timeout: 30000, validateStatus: () => true,
    });
    if (response.status >= 400 && response.status < 500) {
      const message = response.data?.message;
      throw new ToolRefusal(Array.isArray(message) ? message.join('; ') : String(message ?? `Recusado (${response.status})`));
    }
    if (response.status >= 500) throw new Error(`Rota ${path} respondeu ${response.status}`);
    return response.data as T;
  }
}
