import * as Zlib from 'zlib';

/**
 * Extrai as permissões do payload do usuário autenticado (request.user),
 * suportando o formato comprimido (base64 + deflate) usado no JWT e o
 * formato de array já descomprimido.
 *
 * Mesma lógica de decodificação usada em AuthGuard.canActivate — extraída
 * aqui para ser reutilizada por checagens de permissão feitas fora do guard
 * (ex.: rotas herdadas do GenericController que não declaram @Permissions).
 */
export function extractUserPermissions(user: any): string[] {
  const userPermissionsData = user?.permissions || [];

  if (typeof userPermissionsData === 'string') {
    try {
      const decompressed = Zlib.inflateRawSync(
        Buffer.from(userPermissionsData, 'base64'),
        { chunkSize: 1024 * 1024 },
      ).toString('utf8');
      return JSON.parse(decompressed);
    } catch {
      return [];
    }
  }

  if (Array.isArray(userPermissionsData)) {
    return userPermissionsData;
  }

  return [];
}

/**
 * Verifica se o usuário possui ao menos uma das permissões informadas.
 */
export function userHasAnyPermission(user: any, permissions: string[]): boolean {
  const userPermissions = extractUserPermissions(user);
  return permissions.some((permission) => userPermissions.includes(permission));
}
