import { clientIpOf } from './client-ip';
import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { CacheService } from 'src/common/cache/cache.service';
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
export class SecurityService implements OnModuleInit {
  private requestLogs = new Map<string, RequestLog>();
  private blockedIps = new Set<string>();
  private config: SecurityConfig;

  private rateLimitConfig: RateLimitConfig;
  private endpointLimits = new Map<string, RateLimitConfig>();
  /**
   * Padrões de ataque procurados na URL (caminho + query). Precisos de propósito:
   * um falso positivo bloqueia alguém de verdade.
   */
  private suspiciousPatterns = [
    // SQL Injection — só formas de ataque, não palavras soltas ("update", "create")
    /\bunion\s+(all\s+)?select\b/i,
    /\bselect\b[^&]{1,80}\bfrom\b[^&]{1,80}\b(where|information_schema|pg_)/i,
    /\b(drop|truncate)\s+(table|database|schema)\b/i,
    /\binsert\s+into\b/i,
    /\bdelete\s+from\b/i,
    /['"]\s*(or|and)\s+['"\d]+\s*=\s*['"\d]/i, // ' or '1'='1
    /\b(sleep|pg_sleep|benchmark)\s*\(/i,

    // XSS
    /<script[^a-z]/i,
    /<iframe[^a-z]/i,
    /javascript:/i,
    /<img[^>]+on(load|error)\s*=/i,
    /<[^>]+on(click|mouseover|focus|blur)\s*=/i,

    // Path Traversal
    /(\.\.[\/\\]){2,}/, // ../../
    /\.\.%2[fF]|%2[fF]\.\./, // ..%2f e %2f.. (já decodificado uma vez)
    /%2[eE]%2[eE]/, // %2e%2e
    /%25(2[eEfF]|5[cC])/, // codificação dupla (%252f, %252e, %255c)
    /\/\.\.;\//, // /..;/ (Tomcat)

    // OS Command Injection / arquivos do sistema
    /[;&|`]\s*(ls|cat|echo|rm|chmod|chown|wget|curl|nc|bash|sh)\s/i,
    /\/etc\/(passwd|shadow|hosts)/,
    /\/proc\/self\//,
    /(cmd|powershell)\.exe/i,
  ];

  /**
   * Caminhos que só robôs de varredura pedem (a API não tem nada disso).
   * Conferido só no caminho, sem a query.
   */
  private probePathPatterns = [
    /^\/(\.env|\.git|\.svn|\.hg|\.aws|\.ssh|\.docker|\.kube|\.npmrc|\.htaccess|\.htpasswd|\.DS_Store|\.vscode|\.idea|\.config\/gcloud)(\/|$|\.|\?)/i,
    /\/\.env(\.[a-z0-9_-]+)?$/i, // /app/.env, /.env.production
    /\/\.git\/(config|HEAD)/i,
    /\/(wp-admin|wp-login\.php|wp-content|wp-includes|xmlrpc\.php|phpmyadmin|pma|adminer|cgi-bin|actuator|server-status|vendor\/phpunit|boaform|HNAP1|manager\/html|solr\/admin|telescope|_profiler)(\/|$)/i,
    /\.(php\d?|asp|aspx|jsp|cgi|pl)$/i,
    /\/(id_rsa|id_ed25519|credentials|\.git-credentials|privkey\.pem|web\.config|config\.json\.bak|backup\.sql|dump\.sql|database\.sql)$/i,
  ];

  /** No corpo (JSON) só o que não aparece em texto normal — chat e propostas usam "update", "select"... */
  private bodyPatterns = [
    /<script[^a-z]/i,
    /(\.\.[\/\\]){3,}/,
    /\/etc\/(passwd|shadow)/,
    /\/proc\/self\//,
    /\bunion\s+(all\s+)?select\b/i,
  ];

  private suspiciousIps = new Set<string>();
  private whitelistedIps = new Set<string>();

  /** Ataques recentes, para alertar o dono em rajada (um aviso a cada 15 min no máximo). */
  private recentEvents: {
    at: number;
    kind: string;
    ip: string;
    detail: string;
  }[] = [];
  private lastAlertAt = 0;

  constructor(@Optional() private readonly cache?: CacheService) {
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
      enabled: this.config.enabled,
      globalMaxRequests: this.config.global.maxRequests,
      endpoints: Object.keys(this.config.endpoints),
      whitelistedIps: this.config.whitelist.length,
      blacklistedIps: this.config.blacklist.length,
    });

    if (!this.config.enabled) {
      console.warn('⚠️ MÓDULO DE SEGURANÇA DESABILITADO');
    }
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
   * Bloqueia o IP. Fica também no Redis (sobrevive a restart/deploy) e quem
   * reincide em 24 h fica mais tempo de fora: 1x, 4x, depois 24 h.
   */
  blockIp(ip: string, duration: number = 300000, reason = 'bloqueio'): void {
    if (this.isIpWhitelisted(ip)) return;
    if (this.blockedIps.has(ip)) return;
    this.blockedIps.add(ip);
    console.error(
      `🚫 IP BLOQUEADO: ${ip} por ${Math.round(duration / 1000)} segundos (${reason})`,
    );
    this.scheduleUnblock(ip, duration);
    this.recordEvent('bloqueio', ip, reason);

    if (!this.cache) return;
    const offensesKey = `sec:offenses:${ip}`;
    this.cache
      .increment(offensesKey, 24 * 3600)
      .then((n) => {
        const factor = n <= 1 ? 1 : n === 2 ? 4 : 0;
        const finalMs = factor ? duration * factor : 24 * 3600 * 1000;
        if (finalMs > duration) {
          console.error(
            `🚫 IP ${ip} reincidente (${n}ª vez em 24 h): bloqueio estendido para ${Math.round(finalMs / 60000)} min`,
          );
          this.scheduleUnblock(ip, finalMs);
        }
        return this.cache!.set(
          `sec:block:${ip}`,
          { reason, until: Date.now() + finalMs },
          Math.ceil(finalMs / 1000),
        );
      })
      .catch(() => undefined);
  }

  private unblockTimers = new Map<string, NodeJS.Timeout>();
  private scheduleUnblock(ip: string, ms: number): void {
    const prev = this.unblockTimers.get(ip);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.blockedIps.delete(ip);
      this.unblockTimers.delete(ip);
      console.log(`✅ IP DESBLOQUEADO: ${ip}`);
    }, ms);
    t.unref?.();
    this.unblockTimers.set(ip, t);
  }

  /** Recarrega do Redis os bloqueios ainda válidos (depois de um deploy/restart). */
  async onModuleInit(): Promise<void> {
    if (!this.cache) return;
    try {
      const keys = await this.cache.keys('sec:block:*');
      for (const key of keys) {
        const ip = key.slice('sec:block:'.length);
        const ttl = await this.cache.ttl(key);
        if (ttl > 0 && !this.isIpWhitelisted(ip)) {
          this.blockedIps.add(ip);
          this.scheduleUnblock(ip, ttl * 1000);
        }
      }
      if (keys.length)
        console.log(
          `🔒 ${this.blockedIps.size} IP(s) bloqueados recarregados do Redis`,
        );
    } catch {
      // Redis fora: começa sem a lista
    }
  }

  /**
   * Registra um evento de ataque. Em rajada (5+ em 10 min), avisa o dono pelo
   * webhook SECURITY_ALERT_WEBHOOK (ntfy, Discord, Slack, Telegram via bot...).
   */
  recordEvent(kind: string, ip: string, detail: string): void {
    const now = Date.now();
    this.recentEvents.push({
      at: now,
      kind,
      ip,
      detail: String(detail).slice(0, 200),
    });
    this.recentEvents = this.recentEvents
      .filter((e) => now - e.at < 10 * 60 * 1000)
      .slice(-200);
    if (this.cache) {
      const day = new Date().toISOString().slice(0, 10);
      this.cache
        .increment(`sec:stats:${day}:${kind}`, 8 * 24 * 3600)
        .catch(() => undefined);
    }
    if (
      this.recentEvents.length >= 5 &&
      now - this.lastAlertAt > 15 * 60 * 1000
    ) {
      this.lastAlertAt = now;
      const ips = [...new Set(this.recentEvents.map((e) => e.ip))];
      this.notifyAdmins({
        type: 'RAJADA_DE_ATAQUE',
        eventos: this.recentEvents.length,
        ips: ips.slice(0, 10),
        exemplos: this.recentEvents
          .slice(-5)
          .map((e) => `${e.kind}: ${e.ip} — ${e.detail}`),
      });
    }
  }

  /**
   * Registra uma requisição e detecta possíveis ataques
   */
  logRequest(request: Request): { allowed: boolean; reason?: string } {
    // Se a segurança estiver desabilitada, permite tudo
    if (!this.config.enabled) {
      return { allowed: true };
    }

    const ip = this.getClientIp(request);
    const now = Date.now();
    const endpoint = this.getEndpointFromUrl(request.url);
    // O log é por IP somando TODAS as rotas, então tem de ser comparado com
    // o limite global — comparar com o da rota atual (ex.: /upload = 20)
    // bloqueava quem tinha navegado 20 vezes e foi enviar um arquivo.
    // Isto é só a rede de proteção contra flood; o limite do dia a dia
    // (429) é o ThrottlerGuard.
    const config = this.rateLimitConfig;
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
      this.blockIp(ip, 600000, 'lista de IPs suspeitos'); // Bloqueia por 10 minutos
      return { allowed: false, reason: 'IP suspeito' };
    }

    // Verifica padrões maliciosos na requisição
    const maliciousPattern = this.detectMaliciousPatterns(request);
    if (maliciousPattern) {
      console.error(
        `🚨 PADRÃO MALICIOSO DETECTADO: ${ip} - ${maliciousPattern}`,
      );
      this.blockIp(ip, 1800000, maliciousPattern); // Bloqueia por 30 minutos
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
      config.maxRequests * 2 + log.failedRequests.length * 5;

    if (
      log.timestamps.length > effectiveMaxRequests ||
      log.suspiciousScore > this.config.suspiciousScoreThreshold
    ) {
      console.error(
        `🚨 POSSÍVEL DDOS: ${ip} fez ${log.timestamps.length} requests em ${windowMs / 1000}s (Score: ${log.suspiciousScore})`,
      );
      this.blockIp(
        ip,
        config.blockDuration,
        `excesso de requisições (${log.timestamps.length}/min)`,
      );
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

    // Decodifica a URL para evitar bypass com encoding
    let decodedUrl = url;
    try {
      decodedUrl = decodeURIComponent(url);
    } catch {
      // URL mal formada pode ser suspeita
      console.warn('URL mal formada detectada:', url);
    }

    for (const pattern of this.suspiciousPatterns) {
      if (pattern.test(decodedUrl)) {
        return `URL maliciosa: ${pattern}`;
      }
    }

    // Caminhos de varredura (/.env, /.git/config, /wp-admin, *.php...)
    const path = decodedUrl.split('?')[0];
    for (const pattern of this.probePathPatterns) {
      if (pattern.test(path)) {
        return `Varredura: ${path.slice(0, 120)}`;
      }
    }

    // Corpo: só padrões que não aparecem em texto normal
    if (request.body && typeof request.body === 'object') {
      let bodyString = '';
      try {
        bodyString = JSON.stringify(request.body);
      } catch {
        bodyString = '';
      }
      for (const pattern of this.bodyPatterns) {
        if (pattern.test(bodyString)) {
          return `Body malicioso: ${pattern}`;
        }
      }
    }

    // Verifica headers suspeitos
    const userAgent = request.headers['user-agent'] || '';
    if (
      /sqlmap|nikto|nuclei|masscan|zgrab|gobuster|dirbuster|wpscan|acunetix|nessus|scanner/i.test(
        String(userAgent),
      )
    ) {
      return `User-Agent suspeito: ${userAgent}`;
    }

    return null;
  }

  /**
   * Obtém o IP real do cliente
   */
  private getClientIp(request: Request): string {
    return clientIpOf(request);
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

    console.error('🚨 ALERTA DE SEGURANÇA:', JSON.stringify(alert));

    const url = process.env.SECURITY_ALERT_WEBHOOK;
    if (!url || !/^https:\/\//.test(url)) return;
    const text =
      `WorkSafe: ${alert.eventos ?? ''} tentativas de ataque bloqueadas nos últimos minutos.\n` +
      `IPs: ${(alert.ips ?? [alert.ip]).join(', ')}\n` +
      (alert.exemplos ?? []).join('\n');
    // Formato aceito por ntfy (texto puro), Discord ({content}) e Slack ({text})
    const isNtfy = /ntfy\./.test(url);
    fetch(url, {
      method: 'POST',
      headers: isNtfy
        ? { Title: 'Alerta de seguranca WorkSafe' }
        : { 'Content-Type': 'application/json' },
      body: isNtfy
        ? text
        : JSON.stringify({ text, content: text.slice(0, 1900) }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
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
