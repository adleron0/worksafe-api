export interface SecurityConfig {
  enabled: boolean;
  global: {
    windowMs: number;
    maxRequests: number;
    maxBurst: number;
    blockDuration: number;
    cleanupInterval: number;
  };
  endpoints: {
    [key: string]: {
      windowMs: number;
      maxRequests: number;
      maxBurst: number;
      blockDuration: number;
    };
  };
  whitelist: string[];
  blacklist: string[];
  suspiciousScoreThreshold: number;
  enableNotifications: boolean;
}

export const defaultSecurityConfig: SecurityConfig = {
  enabled: true,
  global: {
    windowMs: 60000,
    maxRequests: 200,
    maxBurst: 30,
    blockDuration: 60000,
    cleanupInterval: 300000,
  },
  endpoints: {
    '/classes': {
      windowMs: 60000,
      maxRequests: 100,
      maxBurst: 20,
      blockDuration: 30000,
    },
    '/api': {
      windowMs: 60000,
      maxRequests: 300,
      maxBurst: 50,
      blockDuration: 60000,
    },
    '/auth': {
      windowMs: 60000,
      maxRequests: 30,
      maxBurst: 10,
      blockDuration: 180000,
    },
    '/upload': {
      windowMs: 60000,
      maxRequests: 20,
      maxBurst: 5,
      blockDuration: 300000,
    },
    '/webhook': {
      windowMs: 60000,
      maxRequests: 100,
      maxBurst: 20,
      blockDuration: 60000,
    },
  },
  whitelist: ['127.0.0.1', '::1', 'localhost'],
  blacklist: [
    // Adicione IPs maliciosos conhecidos aqui
  ],
  suspiciousScoreThreshold: 10,
  enableNotifications: true,
};

export function getSecurityConfigFromEnv(): Partial<SecurityConfig> {
  const config: Partial<SecurityConfig> = {};

  // Permite desabilitar completamente o módulo de segurança
  if (process.env.SECURITY_ENABLED !== undefined) {
    config.enabled = process.env.SECURITY_ENABLED === 'true';
  }

  if (process.env.SECURITY_MAX_REQUESTS) {
    config.global = {
      ...defaultSecurityConfig.global,
      maxRequests: parseInt(process.env.SECURITY_MAX_REQUESTS, 10),
    };
  }

  if (process.env.SECURITY_WHITELIST) {
    config.whitelist = process.env.SECURITY_WHITELIST.split(',').map((ip) =>
      ip.trim(),
    );
  }

  if (process.env.SECURITY_BLACKLIST) {
    config.blacklist = process.env.SECURITY_BLACKLIST.split(',').map((ip) =>
      ip.trim(),
    );
  }

  if (process.env.SECURITY_ENABLE_NOTIFICATIONS) {
    config.enableNotifications =
      process.env.SECURITY_ENABLE_NOTIFICATIONS === 'true';
  }

  return config;
}
