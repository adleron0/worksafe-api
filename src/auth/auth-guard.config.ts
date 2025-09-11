/**
 * Configuração centralizada do AuthGuard
 * Define quais rotas devem ser ignoradas pelo guard empresarial
 */

export const AUTH_GUARD_CONFIG = {
  // Rotas que devem ser ignoradas pelo AuthGuard empresarial
  // Essas rotas têm sua própria validação de autenticação
  ignoredRoutes: [
    '/student', // Rotas de alunos - usa StudentAuthGuard
    '/student-courses', // Cursos do aluno
    '/student-lessons', // Aulas do aluno
    '/student-progress', // Progresso do aluno
    '/student-certificates', // Certificados do aluno
    '/student-evaluations', // Avaliações do aluno
    '/auth/student', // Autenticação de alunos
    '/public', // Rotas públicas da API
    '/health', // Health check
    '/docs', // Documentação Swagger
  ],

  // Prefixos de URL que devem ser ignorados
  ignoredPrefixes: [
    '/webhook/', // Webhooks externos
    '/api/v2/', // Futura versão da API com auth diferente
  ],

  // Controllers que devem ser ignorados (por nome da classe)
  ignoredControllers: [
    // 'PublicController',
    // 'WebhookController',
  ],
};

/**
 * Função helper para verificar se uma rota deve ser ignorada
 */
export function shouldIgnoreRoute(url: string): boolean {
  if (!url) return false;

  // Remove query params para comparação
  const urlPath = url.split('?')[0];

  // Verifica rotas exatas ou que começam com o prefixo
  const isIgnoredRoute = AUTH_GUARD_CONFIG.ignoredRoutes.some(
    (route) =>
      urlPath === route ||
      urlPath.startsWith(route + '/') ||
      urlPath.startsWith(route),
  );

  if (isIgnoredRoute) return true;

  // Verifica prefixos
  const hasIgnoredPrefix = AUTH_GUARD_CONFIG.ignoredPrefixes.some((prefix) =>
    urlPath.startsWith(prefix),
  );

  return hasIgnoredPrefix;
}
