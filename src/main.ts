import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PrismaClientInitializationError } from '@prisma/client/runtime/library';
import * as helmet from 'helmet';
import * as rateLimit from 'express-rate-limit';
import * as cookieParser from 'cookie-parser';

const PORT = process.env.PORT || 3000;
const ORIGIN_CORS = process.env.ORIGIN_CORS || '*';

async function bootstrap() {
  try {
    const app = await NestFactory.create(AppModule);
    
    // Cookie parser (movido para cá para evitar erro)
    app.use(cookieParser());
    
    // Helmet para headers de segurança
    app.use(helmet.default({
      contentSecurityPolicy: false, // Desabilita CSP para evitar conflitos com frontend
      crossOriginEmbedderPolicy: false,
    }));

    // Rate limiting específico para /classes (problema identificado)
    const classesLimiter = rateLimit.default({
      windowMs: 1 * 60 * 1000, // 1 minuto
      max: 10, // 10 requests por minuto para /classes
      message: {
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Muitas requisições para /classes. Tente novamente em 1 minuto.',
      },
      standardHeaders: true,
      legacyHeaders: false,
      trustProxy: trustProxyHops === 'true' ? true : parseInt(trustProxyHops, 10), // Configuração segura
      skip: (req) => {
        // Skip rate limit para IPs confiáveis (se necessário)
        const trustedIps = process.env.TRUSTED_IPS?.split(',') || [];
        return trustedIps.includes(req.ip);
      },
    });

    // Verifica se a segurança está habilitada
    const securityEnabled = process.env.SECURITY_ENABLED !== 'false';
    
    if (securityEnabled) {
      // Middleware de detecção de ataques (aplicado globalmente)
      const { SecurityService } = await import('./common/security/security.service');
      const securityService = app.get(SecurityService);
      
      app.use((req, res, next) => {
        const { allowed, reason } = securityService.logRequest(req);
        if (!allowed) {
          console.error(`🚫 REQUISIÇÃO BLOQUEADA:`, {
            ip: req.ip,
            url: req.url,
            method: req.method,
            reason,
          });
          const statusCode = reason?.includes('taxa') || reason?.includes('DDoS') ? 429 : 403;
          return res.status(statusCode).json({
            statusCode,
            message: reason || 'Acesso negado',
            error: 'Forbidden',
            retryAfter: statusCode === 429 ? 300 : undefined,
          });
        }
        next();
      });
    }

    // Aplica rate limits apenas se segurança estiver habilitada
    if (securityEnabled) {
      // Aplica rate limit específico para /classes
      app.use('/classes', classesLimiter);
      app.use('/training/classes', classesLimiter);

      // Rate limiting global mais permissivo
      const globalLimiter = rateLimit.default({
        windowMs: 1 * 60 * 1000, // 1 minuto
        max: 100, // 100 requests por minuto globalmente
        message: {
          statusCode: 429,
          error: 'Too Many Requests',
          message: 'Taxa de requisições excedida. Tente novamente em breve.',
        },
        standardHeaders: true,
        legacyHeaders: false,
        trustProxy: trustProxyHops === 'true' ? true : parseInt(trustProxyHops, 10), // Configuração segura
      });

      app.use(globalLimiter);
    }

    // CORS
    app.enableCors({
      origin: ORIGIN_CORS,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    });

    // Trust proxy configuração segura para produção
    // Define quantos proxies confiáveis existem antes do servidor
    // Use 1 se estiver atrás de um único proxy (nginx, cloudflare, etc)
    const trustProxyHops = process.env.TRUST_PROXY_HOPS || '1';
    app.getHttpAdapter().getInstance().set('trust proxy', trustProxyHops);

    const server = await app.listen(PORT);
    const { port: actualPort } = server.address();
    
    console.log('═══════════════════════════════════════════════════');
    if (securityEnabled) {
      console.log('🔒 SEGURANÇA ATIVADA');
      console.log('═══════════════════════════════════════════════════');
      console.log('✅ Helmet: Headers de segurança configurados');
      console.log('✅ Rate Limiting: Proteção contra DDoS ativa');
      console.log('✅ Attack Detection: Middleware de detecção ativo');
      console.log('✅ Throttler: Rate limiting por IP ativo');
    } else {
      console.log('⚠️  SEGURANÇA DESABILITADA');
      console.log('═══════════════════════════════════════════════════');
      console.log('❌ Módulo de segurança está DESLIGADO');
      console.log('❌ Aplicação vulnerável a ataques');
      console.log('⚠️  Use apenas em desenvolvimento!');
    }
    console.log('═══════════════════════════════════════════════════');
    console.log(`🚀 Application is running on Port ${actualPort}`);
    console.log('═══════════════════════════════════════════════════');
  } catch (error) {
    console.error('Erro ao inicializar a aplicação:', error);
    if (error instanceof PrismaClientInitializationError) {
      console.error('Erro de conexão com o banco de dados:', error.message);
    } else {
      console.error('Erro inesperado:', error);
    }
  }
}
bootstrap();
