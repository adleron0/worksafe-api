import { Injectable } from '@nestjs/common';
import { Request } from 'express';
import {
  SecurityConfig,
  defaultSecurityConfig,
  getSecurityConfigFromEnv,
} from './security.config';

interface RequestLog {
  timestamps: number[];
  blockedUntil?: number;
  requestCount: number;
  suspicious: boolean;
  failedRequests: number[];
  suspiciousScore: number;
}

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  maxBurst: number;
  blockDuration: number;
}

@Injectable()
export class SecurityService {
  private requestLogs = new Map<string, RequestLog>();
  private blockedIps = new Set<string>();
  private config: SecurityConfig;

  private rateLimitConfig: RateLimitConfig;
  private endpointLimits = new Map<string, RateLimitConfig>();
  private suspiciousPatterns = [
    /SELECT.*FROM/i,
    /DROP\s+TABLE/i,
    /INSERT\s+INTO/i,
    /UPDATE.*SET/i,
    /DELETE\s+FROM/i,
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i,
    /\.\.\/\.\.\//,
    /etc\/passwd/,
    /cmd\.exe/i,
    /powershell/i,
  ];

  private suspiciousIps = new Set<string>();
  private whitelistedIps = new Set<string>();

  constructor() {
    // Carrega configuração
    this.loadConfig();

    // Limpa logs antigos conforme configurado
    setInterval(
      () => this.cleanupOldLogs(),
      this.config.global.cleanupInterval,
    );
  }

  private loadConfig(): void {
    const envConfig = getSecurityConfigFromEnv();
    this.config = { ...defaultSecurityConfig, ...envConfig };

    // Configura rate limits globais
    this.rateLimitConfig = {
      windowMs: this.config.global.windowMs,
      maxRequests: this.config.global.maxRequests,
      maxBurst: this.config.global.maxBurst,
      blockDuration: this.config.global.blockDuration,
    };

    // Configura limites por endpoint
    Object.entries(this.config.endpoints).forEach(([endpoint, limits]) => {
      this.endpointLimits.set(endpoint, limits);
    });

    // Configura listas de IPs
    this.whitelistedIps = new Set(this.config.whitelist);
    this.suspiciousIps = new Set(this.config.blacklist);

    console.log('🔒 Configuração de segurança carregada:', {
      globalMaxRequests: this.config.global.maxRequests,
      endpoints: Object.keys(this.config.endpoints),
      whitelistedIps: this.config.whitelist.length,
      blacklistedIps: this.config.blacklist.length,
    });
  }

  /**
   * Verifica se um IP está bloqueado
   */
  isIpBlocked(ip: string): boolean {
    return this.blockedIps.has(ip);
  }

  /**
   * Verifica se um IP é suspeito
   */
  isIpSuspicious(ip: string): boolean {
    return this.suspiciousIps.has(ip);
  }

  /**
   * Verifica se um IP está na whitelist
   */
  isIpWhitelisted(ip: string): boolean {
    return this.whitelistedIps.has(ip) || ip === '127.0.0.1' || ip === '::1';
  }

  /**
   * Adiciona IP à lista de bloqueados
   */
  blockIp(ip: string, duration: number = 300000): void {
    this.blockedIps.add(ip);
    console.error(`🚫 IP BLOQUEADO: ${ip} por ${duration / 1000} segundos`);

    // Remove o bloqueio após o tempo especificado
    setTimeout(() => {
      this.blockedIps.delete(ip);
      console.log(`✅ IP DESBLOQUEADO: ${ip}`);
    }, duration);
  }

  /**
   * Registra uma requisição e detecta possíveis ataques
   */
  logRequest(request: Request): { allowed: boolean; reason?: string } {
    const ip = this.getClientIp(request);
    const now = Date.now();
    const endpoint = this.getEndpointFromUrl(request.url);
    const config = this.endpointLimits.get(endpoint) || this.rateLimitConfig;
    const windowMs = config.windowMs;

    // IPs na whitelist sempre passam
    if (this.isIpWhitelisted(ip)) {
      return { allowed: true };
    }

    // Verifica se o IP está bloqueado
    if (this.isIpBlocked(ip)) {
      return { allowed: false, reason: 'IP bloqueado temporariamente' };
    }

    // Verifica se o IP é suspeito (blacklist)
    if (this.isIpSuspicious(ip)) {
      console.warn(`⚠️ IP SUSPEITO DETECTADO: ${ip} - ${request.url}`);
      this.blockIp(ip, 600000); // Bloqueia por 10 minutos
      return { allowed: false, reason: 'IP suspeito' };
    }

    // Verifica padrões maliciosos na requisição
    const maliciousPattern = this.detectMaliciousPatterns(request);
    if (maliciousPattern) {
      console.error(
        `🚨 PADRÃO MALICIOSO DETECTADO: ${ip} - ${maliciousPattern}`,
      );
      this.blockIp(ip, 1800000); // Bloqueia por 30 minutos
      return {
        allowed: false,
        reason: `Padrão malicioso detectado: ${maliciousPattern}`,
      };
    }

    // Inicializa ou obtém log do IP
    if (!this.requestLogs.has(ip)) {
      this.requestLogs.set(ip, {
        timestamps: [],
        requestCount: 0,
        suspicious: false,
        failedRequests: [],
        suspiciousScore: 0,
      });
    }

    const log = this.requestLogs.get(ip)!;

    // Remove timestamps antigos
    log.timestamps = log.timestamps.filter((time) => now - time < windowMs);
    log.timestamps.push(now);
    log.requestCount++;

    // Limpa requisições falhas antigas
    log.failedRequests = log.failedRequests.filter(
      (time) => now - time < windowMs,
    );

    // Calcula burst rate (requisições nos últimos 5 segundos)
    const burstWindow = 5000;
    const recentBurst = log.timestamps.filter(
      (time) => now - time < burstWindow,
    ).length;

    // Ajusta score de suspeita baseado em comportamento
    if (recentBurst > config.maxBurst) {
      log.suspiciousScore += 2;
    } else if (log.suspiciousScore > 0) {
      log.suspiciousScore = Math.max(0, log.suspiciousScore - 0.5);
    }

    // Detecta DDoS com tolerância para retentativas
    const effectiveMaxRequests =
      config.maxRequests + log.failedRequests.length * 5;

    if (
      log.timestamps.length > effectiveMaxRequests ||
      log.suspiciousScore > this.config.suspiciousScoreThreshold
    ) {
      console.error(
        `🚨 POSSÍVEL DDOS: ${ip} fez ${log.timestamps.length} requests em ${windowMs / 1000}s (Score: ${log.suspiciousScore})`,
      );
      this.blockIp(ip, config.blockDuration);
      log.suspicious = true;

      // Notificar se configurado e realmente suspeito
      if (
        this.config.enableNotifications &&
        log.suspiciousScore > this.config.suspiciousScoreThreshold * 1.5
      ) {
        this.notifyAdmins({
          type: 'DDOS_ATTACK',
          ip,
          requestCount: log.timestamps.length,
          suspiciousScore: log.suspiciousScore,
          url: request.url,
        });
      }

      return { allowed: false, reason: 'Taxa de requisições excedida' };
    }

    // Aviso suave para muitas requisições (não bloqueia imediatamente)
    if (log.timestamps.length > config.maxRequests * 0.7) {
      console.warn(
        `⚠️ RATE LIMIT PRÓXIMO: ${ip} - ${log.timestamps.length}/${config.maxRequests} requests em ${endpoint}`,
      );
    }

    return { allowed: true };
  }

  /**
   * Detecta padrões maliciosos na requisição
   */
  private detectMaliciousPatterns(request: Request): string | null {
    // Verifica URL
    const url = request.url || '';
    for (const pattern of this.suspiciousPatterns) {
      if (pattern.test(url)) {
        return `URL maliciosa: ${pattern}`;
      }
    }

    // Verifica query parameters
    const queryString = JSON.stringify(request.query || {});
    for (const pattern of this.suspiciousPatterns) {
      if (pattern.test(queryString)) {
        return `Query maliciosa: ${pattern}`;
      }
    }

    // Verifica body (se existir)
    if (request.body) {
      const bodyString = JSON.stringify(request.body);
      for (const pattern of this.suspiciousPatterns) {
        if (pattern.test(bodyString)) {
          return `Body malicioso: ${pattern}`;
        }
      }
    }

    // Verifica headers suspeitos
    const userAgent = request.headers['user-agent'] || '';
    if (
      userAgent.includes('sqlmap') ||
      userAgent.includes('nikto') ||
      userAgent.includes('scanner')
    ) {
      return `User-Agent suspeito: ${userAgent}`;
    }

    return null;
  }

  /**
   * Obtém o IP real do cliente
   */
  private getClientIp(request: Request): string {
    // Tenta obter o IP real considerando proxies
    const forwarded = request.headers['x-forwarded-for'];
    if (forwarded) {
      return (forwarded as string).split(',')[0].trim();
    }

    const realIp = request.headers['x-real-ip'];
    if (realIp) {
      return realIp as string;
    }

    return request.ip || request.socket.remoteAddress || 'unknown';
  }

  /**
   * Limpa logs antigos para economizar memória
   */
  private cleanupOldLogs(): void {
    const now = Date.now();
    const maxAge = 300000; // 5 minutos

    for (const [ip, log] of this.requestLogs.entries()) {
      // Remove logs sem atividade recente
      if (
        log.timestamps.length === 0 ||
        now - log.timestamps[log.timestamps.length - 1] > maxAge
      ) {
        this.requestLogs.delete(ip);
      }
    }

    console.log(`🧹 Limpeza de logs: ${this.requestLogs.size} IPs ativos`);
  }

  /**
   * Notifica administradores sobre ataques
   */
  private notifyAdmins(alert: any): void {
    if (!this.config.enableNotifications) return;

    console.error('🚨 ALERTA DE SEGURANÇA:', alert);

    // Exemplo de integração com webhook
    // if (process.env.SECURITY_WEBHOOK_URL) {
    //   axios.post(process.env.SECURITY_WEBHOOK_URL, alert);
    // }
  }

  /**
   * Registra uma falha de requisição (para permitir retentativas)
   */
  registerFailedRequest(request: Request): void {
    const ip = this.getClientIp(request);
    const log = this.requestLogs.get(ip);

    if (log) {
      log.failedRequests.push(Date.now());
      // Reduz score de suspeita para requisições que falharam
      if (log.suspiciousScore > 0) {
        log.suspiciousScore -= 1;
      }
    }
  }

  /**
   * Extrai o endpoint base da URL
   */
  private getEndpointFromUrl(url?: string): string {
    if (!url) return '/api';

    const parts = url.split('/');
    if (parts.length > 1) {
      return `/${parts[1]}`;
    }
    return '/api';
  }

  /**
   * Obtém estatísticas de segurança
   */
  getSecurityStats(): any {
    const activeIps = this.requestLogs.size;
    const blockedIps = this.blockedIps.size;
    const suspiciousActivity = Array.from(this.requestLogs.values()).filter(
      (log) => log.suspicious,
    ).length;

    return {
      activeIps,
      blockedIps,
      suspiciousActivity,
      whitelistedIps: this.whitelistedIps.size,
      blacklistedIps: this.suspiciousIps.size,
      config: {
        globalMaxRequests: this.config.global.maxRequests,
        suspiciousScoreThreshold: this.config.suspiciousScoreThreshold,
        notificationsEnabled: this.config.enableNotifications,
      },
      requestLogs: Array.from(this.requestLogs.entries())
        .sort((a, b) => b[1].suspiciousScore - a[1].suspiciousScore)
        .slice(0, 20)
        .map(([ip, log]) => ({
          ip,
          requestCount: log.requestCount,
          recentRequests: log.timestamps.length,
          suspicious: log.suspicious,
          failedRequests: log.failedRequests.length,
          suspiciousScore: log.suspiciousScore,
        })),
    };
  }

  /**
   * Atualiza configuração em tempo real
   */
  updateConfig(newConfig: Partial<SecurityConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.loadConfig();
    console.log('🔄 Configuração de segurança atualizada');
  }
}
