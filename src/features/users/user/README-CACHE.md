# Como Implementar Cache de Autenticação nos Controllers

## 1. UserController

### Adicionar ao constructor:
```typescript
import { AuthCacheService, InvalidateAuthCache } from 'src/common/cache';

constructor(
  private readonly Service: Service,
  private readonly authCache: AuthCacheService, // ADICIONAR
) {
  super(Service, entity);
}
```

### Adicionar decorators nas rotas:

```typescript
// Atualizar usuário
@Put(':id')
@InvalidateAuthCache('user', (args) => Number(args[0]))
async update(@Param('id') id: number, @Req() request: Request, @Body() dto: UpdateDto) {
  return super.update(id, request, dto);
}

// Inativar usuário
@Patch('inactive/:id')
@InvalidateAuthCache('user', (args) => Number(args[0]))
async inactivate(@Param('id') id: number, @Req() request: Request) {
  return super.inactivate(id, request);
}

// Ativar usuário
@Patch('active/:id')
@InvalidateAuthCache('user', (args) => Number(args[0]))
async activate(@Param('id') id: number, @Req() request: Request) {
  return super.activate(id, request);
}
```

## 2. PermissionsController

### Para permissões de usuário:

```typescript
// Adicionar permissão
@Post('user-permission')
async addUserPermission(@Req() request: Request, @Body() dto: CreateUserPermissionDto) {
  const result = await this.service.addPermission(dto);
  
  // Invalidar cache do usuário
  await this.authCache.invalidateUserCache(dto.userId);
  
  return result;
}

// Remover permissão
@Delete('user-permission/:userId/:permissionId')
async removeUserPermission(
  @Param('userId') userId: number,
  @Param('permissionId') permissionId: number
) {
  const result = await this.service.removePermission(userId, permissionId);
  
  // Invalidar cache do usuário
  await this.authCache.invalidateUserCache(userId);
  
  return result;
}
```

### Para permissões de perfil (afeta múltiplos usuários):

```typescript
// Adicionar permissão ao perfil
@Post('profile-permission')
async addProfilePermission(@Body() dto: CreateProfilePermissionDto) {
  const result = await this.service.addProfilePermission(dto);
  
  // Invalidar cache de todos os usuários com esse perfil
  await this.authCache.smartInvalidate({ profileId: dto.profileId });
  
  return result;
}
```

## 3. ProfileController

```typescript
// Atualizar perfil
@Put(':id')
@InvalidateAuthCache('profile', (args) => Number(args[0]))
async updateProfile(@Param('id') id: number, @Body() dto: UpdateProfileDto) {
  return super.update(id, request, dto);
}

// Inativar perfil
@Patch('inactive/:id')
@InvalidateAuthCache('profile', (args) => Number(args[0]))
async inactivateProfile(@Param('id') id: number) {
  return super.inactivate(id, request);
}
```

## 4. CompanyController

```typescript
// Inativar empresa (afeta TODOS os usuários)
@Patch('inactive/:id')
@InvalidateAuthCache('company', (args) => Number(args[0]))
async inactivateCompany(@Param('id') id: number) {
  return super.inactivate(id, request);
}

// Ativar empresa
@Patch('active/:id')
@InvalidateAuthCache('company', (args) => Number(args[0]))
async activateCompany(@Param('id') id: number) {
  return super.activate(id, request);
}
```

## Operações Manuais (sem decorator)

Para casos mais complexos, use o serviço diretamente:

```typescript
// Exemplo: operação que afeta múltiplos contextos
async complexOperation(@Param('id') id: number) {
  const result = await this.service.doSomething(id);
  
  // Invalidar cache com contexto específico
  await this.authCache.smartInvalidate({
    userId: result.userId,
    companyId: result.companyId,
    profileId: result.profileId,
    userIds: result.affectedUserIds
  });
  
  return result;
}
```

## Resumo dos Parâmetros do Decorator

- `'user'` - Invalida cache de um usuário específico
- `'users'` - Invalida cache de múltiplos usuários
- `'company'` - Invalida cache de todos os usuários de uma empresa
- `'profile'` - Invalida cache de todos os usuários com um perfil

O segundo parâmetro é uma função que extrai o ID dos argumentos do método:
- `args[0]` - Geralmente o ID do parâmetro de rota
- `args[1]` - Geralmente o body da requisição
- `args[2]` - Outros parâmetros