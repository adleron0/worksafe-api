# Sistema de Cache para Autenticação - WorkSafe API

## Visão Geral

O sistema de cache de autenticação foi implementado para reduzir a carga no banco de dados durante operações frequentes como refresh de token e validação de permissões. O cache armazena dados de sessão e permissões de usuário com invalidação inteligente.

## Estratégia de Cache

### 1. Cache de Sessão (Refresh Token)
- **Key**: `session:${userId}:${refreshToken}`
- **TTL**: 7 dias (mesmo tempo do refresh token)
- **Conteúdo**: Dados completos da sessão incluindo usuário, perfil, permissões e empresa
- **Uso**: Durante o refresh token, evitando queries complexas no banco

### 2. Cache de Permissões de Usuário
- **Key**: `user:${userId}:permissions`
- **TTL**: 1 hora (balanceando performance e segurança)
- **Conteúdo**: Dados do usuário com perfil, permissões individuais e da role
- **Uso**: Validação rápida de permissões em requisições

## Implementação

### AuthCacheService

O serviço principal que gerencia o cache de autenticação:

```typescript
import { AuthCacheService } from 'src/common/cache';

@Injectable()
export class SeuService {
  constructor(private authCache: AuthCacheService) {}

  async exemplo() {
    // Buscar dados do usuário com cache
    const cached = await this.authCache.getUserWithPermissions(userId);
    
    // Invalidar cache de um usuário
    await this.authCache.invalidateUserCache(userId);
    
    // Invalidar cache de múltiplos usuários
    await this.authCache.invalidateMultipleUsersCache([1, 2, 3]);
    
    // Invalidar por empresa
    await this.authCache.invalidateCompanyCache(companyId);
  }
}
```

### Decorator @InvalidateAuthCache

Use o decorator para invalidar cache automaticamente após operações:

```typescript
import { InvalidateAuthCache } from 'src/common/cache';

@Controller('users')
export class UserController {
  
  // Invalida cache ao atualizar usuário
  @Put(':id')
  @InvalidateAuthCache('user', (args) => args[0]) // args[0] é o id
  async update(@Param('id') id: number, @Body() dto: UpdateUserDto) {
    return this.userService.update(id, dto);
  }

  // Invalida cache ao inativar
  @Patch('inactive/:id')
  @InvalidateAuthCache('user', (args) => args[0])
  async inactivate(@Param('id') id: number) {
    return this.userService.inactivate(id);
  }
}
```

## Onde Implementar Invalidação

### 1. UserController
- ✅ `PUT /user/:id` - Atualizar usuário
- ✅ `PATCH /user/active/:id` - Ativar usuário
- ✅ `PATCH /user/inactive/:id` - Inativar usuário
- ✅ `DELETE /user/:id` - Deletar usuário

### 2. PermissionsController
- ✅ `POST /user-permissions` - Adicionar permissão ao usuário
- ✅ `DELETE /user-permissions` - Remover permissão do usuário
- ✅ `POST /profile-permissions` - Adicionar permissão ao perfil
- ✅ `DELETE /profile-permissions` - Remover permissão do perfil

### 3. ProfileController
- ✅ `PUT /profile/:id` - Atualizar perfil
- ✅ `PATCH /profile/active/:id` - Ativar perfil
- ✅ `PATCH /profile/inactive/:id` - Inativar perfil

### 4. CompanyController
- ✅ `PUT /company/:id` - Atualizar empresa
- ✅ `PATCH /company/active/:id` - Ativar empresa
- ✅ `PATCH /company/inactive/:id` - Inativar empresa

## Exemplo de Implementação Completa

### 1. Adicionar AuthCacheService ao Controller

```typescript
import { AuthCacheService, InvalidateAuthCache } from 'src/common/cache';

@Controller('user')
export class UserController {
  constructor(
    private readonly service: UserService,
    private readonly authCache: AuthCacheService, // Adicionar
  ) {}
}
```

### 2. Usar o Decorator nas Rotas

```typescript
// Invalidar cache de um usuário específico
@Put(':id')
@InvalidateAuthCache('user', (args) => args[0])
async update(@Param('id') id: number, @Body() dto: UpdateDto) {
  return this.service.update(id, dto);
}

// Invalidar cache de múltiplos usuários (ex: ao mudar perfil)
@Put('profile/:id')
@InvalidateAuthCache('profile', (args) => args[0])
async updateProfile(@Param('id') id: number, @Body() dto: UpdateProfileDto) {
  return this.service.updateProfile(id, dto);
}

// Invalidar cache por empresa
@Patch('company/:id/inactive')
@InvalidateAuthCache('company', (args) => args[0])
async inactivateCompany(@Param('id') id: number) {
  return this.service.inactivateCompany(id);
}
```

## Manual de Uso - Passo a Passo

### Para Controllers que Afetam Usuários:

1. **Importe as dependências**:
```typescript
import { AuthCacheService, InvalidateAuthCache } from 'src/common/cache';
```

2. **Injete o AuthCacheService** (se não usar decorator):
```typescript
constructor(
  private readonly service: SeuService,
  private readonly authCache: AuthCacheService,
) {}
```

3. **Use o decorator nas rotas que modificam dados**:
```typescript
@Put(':id')
@InvalidateAuthCache('user', (args) => args[0])
async update(@Param('id') id: number) {
  // seu código
}
```

### Para Operações Complexas:

Se precisar invalidar cache com lógica customizada:

```typescript
@Put(':id/complex-operation')
async complexOperation(@Param('id') id: number) {
  const result = await this.service.doSomething(id);
  
  // Invalidar cache manualmente com contexto
  await this.authCache.smartInvalidate({
    userId: id,
    companyId: result.companyId,
    profileId: result.profileId,
  });
  
  return result;
}
```

## Benefícios

1. **Performance**: Reduz drasticamente queries ao banco durante refresh token
2. **Escalabilidade**: Redis permite cache distribuído entre múltiplas instâncias
3. **Segurança**: TTL curto para permissões + invalidação imediata em mudanças
4. **Flexibilidade**: Sistema adaptável para diferentes cenários

## Monitoramento

Acompanhe os logs para verificar o funcionamento:

```
Session cache hit for user 123
Cache invalidated for user 456
Cache invalidated for company 789
```

## Troubleshooting

### Cache não está sendo invalidado
- Verifique se o AuthCacheService está injetado
- Confirme que o decorator está aplicado corretamente
- Veja os logs de erro

### Performance não melhorou
- Verifique se o Redis está funcionando
- Confirme que o cache está sendo usado no refreshToken
- Monitore hits/misses do cache