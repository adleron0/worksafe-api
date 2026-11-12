import { legacyOrQuery } from './common/crud/legacy-query.middleware';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PrismaClientInitializationError } from '@prisma/client/runtime/library';
import * as helmet from 'helmet';
import * as cookieParser from 'cookie-parser';
import * as express from 'express';
import { defaultSecurityConfig } from './common/security/security.config';
import { isTrustedServerRequest } from './common/security/trusted-server';

const PORT = process.env.PORT || 3000;
const ORIGIN_CORS = process.env.ORIGIN_CORS || '*';

async function bootstrap() {
  try {
    const app = await NestFactory.create(AppModule, {
      bodyParser: true, // Garantir que o body parser está ativado
    });

    // Trust proxy configuração segura para produção
    // Define quantos proxies confiáveis existem antes do servidor
    // Use 1 se estiver atrás de um único proxy (nginx, cloudflare, etc)
    const trustProxyHops = process.env.TRUST_PROXY_HOPS || '1';

    // Configurar limites do body parser
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Cookie parser (movido para cá para evitar erro)
    app.use(cookieParser());
    // Formato antigo de OR (JSON) usado pelo site → grupos or.N do crud-core.
    app.use(legacyOrQuery);

    // Helmet para headers de segurança
    app.use(
      helmet.default({
        contentSecurityPolicy: false, // Desabilita CSP para evitar conflitos com frontend
        crossOriginEmbedderPolicy: false,
      }),
    );

    // Verifica se a segurança está habilitada
    const securityEnabled = process.env.SECURITY_ENABLED !== 'false';

    if (securityEnabled) {
      // Middleware de detecção de ataques (aplicado globalmente)
      const { SecurityService } = await import(
        './common/security/security.service'
      );
      const securityService = app.get(SecurityService);

      app.use((req, res, next) => {
        if (isTrustedServerRequest(req)) return next();
        const { allowed, reason } = securityService.logRequest(req);
        if (!allowed) {
          console.error(`🚫 REQUISIÇÃO BLOQUEADA:`, {
            ip: req.ip,
            url: req.url,
            method: req.method,
            reason,
          });
          const statusCode =
            reason?.includes('taxa') ||
            reason?.includes('DDoS') ||
            reason?.includes('bloqueado temporariamente')
              ? 429
              : 403;
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

    // Rate limit por IP: um só lugar, o ThrottlerGuard global
    // (SecurityModule). Antes havia mais dois limitadores express aqui
    // (100/min geral e 10/min em /classes) somando com os do Nest.

    // CORS
    app.enableCors({
      origin: ORIGIN_CORS,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    });

    // Configura trust proxy de forma segura
    app
      .getHttpAdapter()
      .getInstance()
      .set('trust proxy', parseInt(trustProxyHops, 10));

    const server = await app.listen(PORT);
    const { port: actualPort } = server.address();

    console.log('═══════════════════════════════════════════════════');
    if (securityEnabled) {
      // Calcula burst dinamicamente
      const calcBurst = (burst: number) => Math.floor(burst / 5); // 5 segundos de janela

      console.log('🔒 SEGURANÇA ATIVADA');
      console.log('═══════════════════════════════════════════════════');
      console.log('✅ Helmet: Headers de segurança configurados');
      console.log('✅ Rate Limiting: Proteção contra DDoS ativa');
      console.log(
        `   ├─ Padrão: ${defaultSecurityConfig.global.maxRequests} req/min | Burst: ${calcBurst(defaultSecurityConfig.global.maxBurst)} req/seg`,
      );
      console.log(
        `   ├─ Classes: ${defaultSecurityConfig.endpoints['/classes'].maxRequests} req/min | Burst: ${calcBurst(defaultSecurityConfig.endpoints['/classes'].maxBurst)} req/seg`,
      );
      console.log(
        `   ├─ API: ${defaultSecurityConfig.endpoints['/api'].maxRequests} req/min | Burst: ${calcBurst(defaultSecurityConfig.endpoints['/api'].maxBurst)} req/seg`,
      );
      console.log(
        `   ├─ Auth: ${defaultSecurityConfig.endpoints['/auth'].maxRequests} req/min | Burst: ${calcBurst(defaultSecurityConfig.endpoints['/auth'].maxBurst)} req/seg`,
      );
      console.log(
        `   ├─ Upload: ${defaultSecurityConfig.endpoints['/upload'].maxRequests} req/min | Burst: ${calcBurst(defaultSecurityConfig.endpoints['/upload'].maxBurst)} req/seg`,
      );
      console.log('   └─ Webhooks: Sem limite (ignorado)');
      console.log('✅ Attack Detection: Middleware de detecção ativo');
      console.log('✅ Throttler: Rate limiting por IP ativo');
      console.log(
        `   └─ Bloqueio: ${defaultSecurityConfig.global.blockDuration / 1000} segundos após exceder limite`,
      );
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
