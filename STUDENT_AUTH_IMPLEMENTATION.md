# Implementação de Autenticação para Alunos (Student/Trainee)

## Contexto
O sistema atual possui autenticação voltada para o sistema interno das empresas, com permissões complexas e controle de acesso baseado em perfis empresariais. Há necessidade de criar um sistema de autenticação separado para alunos (trainees) que acessarão a plataforma para realizar cursos, exames e visualizar certificados.

## Decisão de Arquitetura
Criar um **decorator específico para autenticação de alunos** (`@StudentAuth()`), mantendo o decorator `@Public()` existente para rotas públicas gerais.

### Justificativa
- **Separação clara de contextos**: Sistema empresarial vs Sistema de alunos
- **Segurança**: Tokens JWT com secrets diferentes
- **Manutenibilidade**: Cada sistema evolui independentemente
- **Simplicidade**: Alunos não precisam de permissões complexas como empresas

## Estrutura Proposta

### 1. Guard de Autenticação para Alunos
```typescript
// src/auth/guards/student-auth.guard.ts
@Injectable()
export class StudentAuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Verifica se a rota é pública (usando @Public() existente)
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);
    
    if (!token) {
      throw new UnauthorizedException('Token não encontrado');
    }

    try {
      // Valida JWT com secret específico para alunos
      const payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_STUDENT_SECRET
      });
      
      // Adiciona informações do aluno ao request
      request['traineeId'] = payload.traineeId;
      request['userType'] = 'student';
      request['student'] = payload;
      
      return true;
    } catch {
      throw new UnauthorizedException('Token inválido');
    }
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const authHeader = request.headers.authorization;
    if (!authHeader) return undefined;

    const [type, token] = authHeader.split(' ');
    return type === 'Bearer' ? token : undefined;
  }
}
```

### 2. Decorator para Autenticação de Alunos
```typescript
// src/auth/decorators/student-auth.decorator.ts
import { applyDecorators, UseGuards } from '@nestjs/common';
import { StudentAuthGuard } from '../guards/student-auth.guard';

export const StudentAuth = () => applyDecorators(
  UseGuards(StudentAuthGuard)
);
```

### 3. Service de Autenticação para Alunos
```typescript
// src/auth/student-auth.service.ts
@Injectable()
export class StudentAuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async loginStudent(cpf: string, password: string) {
    const trainee = await this.prisma.trainee.findUnique({
      where: { cpf },
      select: {
        id: true,
        cpf: true,
        name: true,
        email: true,
        password: true,
        active: true,
        customerId: true
      }
    });
    
    if (!trainee || !trainee.active) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    // Validar senha (usar bcrypt)
    const isPasswordValid = await bcrypt.compare(password, trainee.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciais inválidas');
    }
    
    // Payload simplificado para alunos
    const payload = {
      traineeId: trainee.id,
      cpf: trainee.cpf,
      name: trainee.name,
      email: trainee.email,
      customerId: trainee.customerId,
      type: 'student'
    };
    
    return {
      accessToken: this.jwtService.sign(payload, {
        secret: process.env.JWT_STUDENT_SECRET,
        expiresIn: '7d' // Sessão mais longa para alunos
      }),
      trainee: {
        id: trainee.id,
        name: trainee.name,
        email: trainee.email
      }
    };
  }

  async validateStudentToken(token: string) {
    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_STUDENT_SECRET
      });
      return payload;
    } catch {
      throw new UnauthorizedException('Token inválido');
    }
  }
}
```

### 4. Controller de Autenticação para Alunos
```typescript
// src/auth/student-auth.controller.ts
@Controller('auth/student')
export class StudentAuthController {
  constructor(private readonly studentAuthService: StudentAuthService) {}

  @Public() // Usa o decorator Public existente
  @Post('login')
  async login(@Body() dto: StudentLoginDto) {
    return this.studentAuthService.loginStudent(dto.cpf, dto.password);
  }

  @StudentAuth() // Requer autenticação de aluno
  @Get('me')
  async getProfile(@Req() req) {
    return req.student;
  }

  @StudentAuth()
  @Post('logout')
  async logout(@Req() req) {
    // Implementar logout se necessário (invalidar token)
    return { message: 'Logout realizado com sucesso' };
  }
}
```

### 5. Exemplo de Uso em Controllers de Recursos
```typescript
// src/features/student/courses/student-courses.controller.ts
@Controller('student/courses')
@StudentAuth() // Aplica autenticação em todas as rotas do controller
export class StudentCoursesController {
  
  @Get('my-courses')
  async getMyCourses(@Req() req) {
    const traineeId = req.traineeId;
    // Buscar cursos do aluno
  }
  
  @Get('available')
  async getAvailableCourses(@Req() req) {
    const customerId = req.student.customerId;
    // Buscar cursos disponíveis para o customer do aluno
  }

  @Post('enroll/:courseId')
  async enrollInCourse(
    @Param('courseId') courseId: string,
    @Req() req
  ) {
    const traineeId = req.traineeId;
    // Matricular aluno no curso
  }
}
```

## Variáveis de Ambiente Necessárias
```env
# JWT para sistema empresarial (já existe)
JWT_ACCESS_SECRET=secret_atual_empresas

# JWT para sistema de alunos (novo)
JWT_STUDENT_SECRET=secret_diferente_para_alunos
```

## Permissões Simplificadas para Alunos
Ao contrário do sistema empresarial que possui permissões granulares, o sistema de alunos terá controle baseado em:

1. **Autenticação**: Aluno está logado ou não
2. **Propriedade**: Aluno só pode acessar seus próprios recursos
3. **Status**: Verificar se aluno está ativo
4. **Vínculo**: Verificar vínculo com customer/empresa

### Exemplo de Validação Simples
```typescript
// Em vez de permissões complexas, validações diretas
@StudentAuth()
@Get('certificate/:certificateId')
async getCertificate(
  @Param('certificateId') certificateId: string,
  @Req() req
) {
  const certificate = await this.prisma.traineeCourseCertificate.findFirst({
    where: {
      id: certificateId,
      traineeId: req.traineeId // Garante que é do próprio aluno
    }
  });
  
  if (!certificate) {
    throw new ForbiddenException('Certificado não encontrado ou não autorizado');
  }
  
  return certificate;
}
```

## Próximos Passos

1. **Criar estrutura de pastas**:
   ```
   src/auth/
   ├── guards/
   │   ├── auth.guard.ts (existente - empresas)
   │   └── student-auth.guard.ts (novo - alunos)
   ├── decorators/
   │   ├── public.decorator.ts (existente)
   │   └── student-auth.decorator.ts (novo)
   ├── student-auth.service.ts (novo)
   ├── student-auth.controller.ts (novo)
   └── auth.module.ts (atualizar para incluir novos componentes)
   ```

2. **Atualizar módulo de autenticação** para registrar novos guards e services

3. **Criar DTOs específicos**:
   ```typescript
   // src/auth/dtos/student-auth.dto.ts
   export class StudentLoginDto {
     @IsString()
     @IsCPF()
     cpf: string;

     @IsString()
     @MinLength(6)
     password: string;
   }
   ```

4. **Implementar endpoints para alunos**:
   - `/auth/student/login` - Login
   - `/auth/student/me` - Perfil do aluno logado
   - `/auth/student/refresh` - Refresh token (se necessário)
   - `/auth/student/reset-password` - Reset de senha

5. **Criar controllers específicos** para recursos dos alunos em `/student/*`

## Considerações de Segurança

1. **Secrets diferentes**: Usar JWT secrets diferentes para empresa e alunos
2. **Expiração de token**: Alunos podem ter tokens com maior duração (7 dias vs 1 dia)
3. **Rate limiting**: Aplicar rate limiting específico para rotas de alunos
4. **Isolamento**: Garantir que alunos não possam acessar rotas empresariais e vice-versa
5. **Auditoria**: Log de todas as ações dos alunos para compliance

## Observações
- O decorator `@Public()` continua funcionando normalmente para rotas públicas
- Rotas com `@StudentAuth()` exigem token JWT de aluno válido
- Rotas sem decorators continuam usando o `AuthGuard` empresarial padrão (comportamento atual)
- Esta arquitetura permite evolução independente dos dois sistemas