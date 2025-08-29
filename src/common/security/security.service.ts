import { Injectable } from '@nestjs/common';
import { Request } from 'express';

interface RequestLog {
  timestamps: number[];
  blockedUntil?: number;
  requestCount: number;
  suspicious: boolean;
}

@Injectable()
export class SecurityService {
  private requestLogs = new Map<string, RequestLog>();
  private blockedIps = new Set<string>();
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

  // IPs suspeitos conhecidos (adicione conforme necessário)
  private suspiciousIps = new Set([
    '100.64.0.11',
    '100.64.0.14',
    // Adicione outros IPs suspeitos aqui
  ]);

  constructor() {
    // Limpa logs antigos a cada 5 minutos
    setInterval(() => this.cleanupOldLogs(), 5 * 60 * 1000);
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
    const windowMs = 60000; // 1 minuto

    // Verifica se o IP está bloqueado
    if (this.isIpBlocked(ip)) {
      return { allowed: false, reason: 'IP bloqueado temporariamente' };
    }

    // Verifica se o IP é suspeito
    if (this.isIpSuspicious(ip)) {
      console.warn(`⚠️ IP SUSPEITO DETECTADO: ${ip} - ${request.url}`);
      this.blockIp(ip, 600000); // Bloqueia por 10 minutos
      return { allowed: false, reason: 'IP suspeito' };
    }

    // Verifica padrões maliciosos na requisição
    const maliciousPattern = this.detectMaliciousPatterns(request);
    if (maliciousPattern) {
      console.error(`🚨 PADRÃO MALICIOSO DETECTADO: ${ip} - ${maliciousPattern}`);
      this.blockIp(ip, 1800000); // Bloqueia por 30 minutos
      return { allowed: false, reason: `Padrão malicioso detectado: ${maliciousPattern}` };
    }

    // Inicializa ou obtém log do IP
    if (!this.requestLogs.has(ip)) {
      this.requestLogs.set(ip, {
        timestamps: [],
        requestCount: 0,
        suspicious: false,
      });
    }

    const log = this.requestLogs.get(ip)!;
    
    // Remove timestamps antigos
    log.timestamps = log.timestamps.filter(time => now - time < windowMs);
    log.timestamps.push(now);
    log.requestCount++;

    // Detecta DDoS: mais de 50 requests por minuto
    if (log.timestamps.length > 50) {
      console.error(`🚨 POSSÍVEL DDOS: ${ip} fez ${log.timestamps.length} requests em 1 minuto`);
      this.blockIp(ip, 300000); // Bloqueia por 5 minutos
      log.suspicious = true;
      
      // Notificar administradores (implementar conforme necessário)
      this.notifyAdmins({
        type: 'DDOS_ATTACK',
        ip,
        requestCount: log.timestamps.length,
        url: request.url,
      });
      
      return { allowed: false, reason: 'Taxa de requisições excedida (possível DDoS)' };
    }

    // Detecta comportamento suspeito: muitas requisições para /classes
    if (request.url?.includes('/classes') && log.timestamps.length > 10) {
      console.warn(`⚠️ COMPORTAMENTO SUSPEITO: ${ip} - ${log.timestamps.length} requests para /classes`);
      
      if (log.timestamps.length > 20) {
        this.blockIp(ip, 180000); // Bloqueia por 3 minutos
        return { allowed: false, reason: 'Muitas requisições para /classes' };
      }
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
    if (userAgent.includes('sqlmap') || userAgent.includes('nikto') || userAgent.includes('scanner')) {
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
      if (log.timestamps.length === 0 || 
          now - log.timestamps[log.timestamps.length - 1] > maxAge) {
        this.requestLogs.delete(ip);
      }
    }
    
    console.log(`🧹 Limpeza de logs: ${this.requestLogs.size} IPs ativos`);
  }

  /**
   * Notifica administradores sobre ataques
   */
  private notifyAdmins(alert: any): void {
    // Implementar notificação por email, Slack, Discord, etc.
    console.error('🚨 ALERTA DE SEGURANÇA:', alert);
    
    // Exemplo de integração com webhook
    // axios.post(process.env.SECURITY_WEBHOOK_URL, alert);
  }

  /**
   * Obtém estatísticas de segurança
   */
  getSecurityStats(): any {
    const activeIps = this.requestLogs.size;
    const blockedIps = this.blockedIps.size;
    const suspiciousActivity = Array.from(this.requestLogs.values())
      .filter(log => log.suspicious).length;
    
    return {
      activeIps,
      blockedIps,
      suspiciousActivity,
      requestLogs: Array.from(this.requestLogs.entries()).map(([ip, log]) => ({
        ip,
        requestCount: log.requestCount,
        recentRequests: log.timestamps.length,
        suspicious: log.suspicious,
      })),
    };
  }
}