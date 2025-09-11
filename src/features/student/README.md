# Sistema de Cursos Online para Alunos

## Visão Geral
Sistema completo de cursos online para alunos/trainees, com autenticação própria, progresso de aprendizado, avaliações e certificados.

## Status de Implementação

### ✅ Concluído
- [x] Sistema de autenticação de alunos (`@StudentAuth()`)
- [x] Recuperação de senha com código por email
- [x] Feature student/student (perfil do aluno)

### ✅ Implementado

#### 1. Feature: student-courses (Listagem de Cursos)
**Status:** ✅ Implementado

**Controller:** `src/features/training/student-courses/controller.ts`
```typescript
const entity = {
  model: 'CourseClassSubscription' as keyof PrismaClient,
  name: 'StudentCourses',
  route: 'student-courses',
  permission: 'student-courses',
};
```

**Rotas Genéricas:**
- `GET /student-courses` - Lista turmas disponíveis
- `POST /student-courses` - Inscrição em turma
- `PUT /student-courses/:id` - Atualização de inscrição
- `PATCH /student-courses/active/:id` - Ativar inscrição
- `PATCH /student-courses/inactive/:id` - Cancelar inscrição

**Rotas Específicas:**
- `GET /student-courses/my-courses` - Minhas turmas inscritas
- `GET /student-courses/:classId/lessons` - Aulas de uma turma

**Arquivos:**
- [x] controller.ts
- [x] service.ts
- [x] module.ts
- [x] dto/create.dto.ts
- [x] dto/update.dto.ts
- [x] interfaces/interface.ts
- [x] rules.ts
- [x] associations.ts

**Notas de Implementação:**
- Model corrigido para `CourseClassSubscription` (tabela de inscrições)
- Validações incluem: período de inscrição, vagas disponíveis, turma ativa
- Hook de criação registra log de inscrição
- Hook de update valida que é o próprio aluno alterando

#### 2. Feature: student-lessons (Aulas Online)
**Status:** ✅ Implementado

**Controller:** `src/features/training/student-lessons/controller.ts`
```typescript
const entity = {
  model: 'OnlineLesson' as keyof PrismaClient,
  name: 'StudentLessons',
  route: 'student-lessons',
  permission: 'student-lessons',
};
```

**Rotas Genéricas:**
- `GET /student-lessons` - Lista aulas (filtradas por turmas inscritas)

**Rotas Específicas:**
- `GET /student-lessons/:lessonId/content` - Conteúdo completo da aula
- `GET /student-lessons/:lessonId/steps` - Steps com progresso do aluno
- `POST /student-lessons/:lessonId/start` - Iniciar aula
- `POST /student-lessons/:lessonId/complete` - Concluir aula

**Arquivos:**
- [x] controller.ts
- [x] service.ts
- [x] module.ts
- [x] dto/create.dto.ts
- [x] dto/update.dto.ts
- [x] interfaces/interface.ts
- [x] rules.ts
- [x] associations.ts

**Notas de Implementação:**
- GET filtrado automaticamente pelas turmas que o aluno está inscrito
- Validação de acesso em todos os métodos específicos
- Atualização automática do progresso do curso ao concluir aula
- Criação de logs para início e conclusão de aulas

#### 3. Feature: student-progress (Progresso)
**Status:** ⏳ Não iniciado

**Controller:** `src/features/training/student-progress/controller.ts`
```typescript
const entity = {
  model: 'StudentStepProgress' as keyof PrismaClient,
  name: 'StudentProgress',
  route: 'student-progress',
  permission: 'student-progress',
};
```

**Rotas Genéricas:**
- `GET /student-progress` - Lista progresso
- `POST /student-progress` - Criar progresso
- `PUT /student-progress/:id` - Atualizar progresso

**Rotas Específicas:**
- `POST /student-progress/step/:stepId/complete` - Concluir step
- `GET /student-progress/lesson/:lessonId` - Progresso da aula
- `GET /student-progress/course/:courseId` - Progresso do curso

**Arquivos:**
- [ ] controller.ts
- [ ] service.ts
- [ ] module.ts
- [ ] dto/create.dto.ts
- [ ] dto/update.dto.ts
- [ ] interfaces/interface.ts
- [ ] rules.ts
- [ ] associations.ts

#### 4. Feature: student-certificates (Certificados)
**Status:** ⏳ Não iniciado

**Controller:** `src/features/training/student-certificates/controller.ts`
```typescript
const entity = {
  model: 'Certificate' as keyof PrismaClient,
  name: 'StudentCertificates',
  route: 'student-certificates',
  permission: 'student-certificates',
};
```

**Rotas Genéricas:**
- `GET /student-certificates` - Lista certificados

**Rotas Específicas:**
- `GET /student-certificates/:id/download` - Download PDF
- `POST /student-certificates/generate/:courseId` - Gerar certificado

**Arquivos:**
- [ ] controller.ts
- [ ] service.ts
- [ ] module.ts
- [ ] dto/create.dto.ts
- [ ] dto/update.dto.ts
- [ ] interfaces/interface.ts
- [ ] rules.ts
- [ ] associations.ts

#### 5. Feature: student-evaluations (Avaliações)
**Status:** ⏳ Não iniciado

**Controller:** `src/features/training/student-evaluations/controller.ts`
```typescript
const entity = {
  model: 'OnlineEvaluation' as keyof PrismaClient,
  name: 'StudentEvaluations',
  route: 'student-evaluations',
  permission: 'student-evaluations',
};
```

**Rotas Genéricas:**
- `GET /student-evaluations` - Lista avaliações
- `POST /student-evaluations` - Submeter resposta

**Rotas Específicas:**
- `GET /student-evaluations/:id/questions` - Questões
- `POST /student-evaluations/:id/submit` - Enviar respostas
- `GET /student-evaluations/:id/result` - Resultado

**Arquivos:**
- [ ] controller.ts
- [ ] service.ts
- [ ] module.ts
- [ ] dto/create.dto.ts
- [ ] dto/update.dto.ts
- [ ] interfaces/interface.ts
- [ ] rules.ts
- [ ] associations.ts

## Padrões Obrigatórios

### Estrutura de rules.ts
```typescript
export const noCompany = true;
export const omitAttributes = ['password'];
export const encryptFields: string[] = [];

export function validateCreate(request: Request, CreateDto: any) { }
export function formaterPreUpdate(UpdateDto: any) { return UpdateDto; }

// Apenas estes 4 hooks são permitidos:
async function hookPreCreate(params) { }
async function hookPosCreate(params, created) { }
async function hookPreUpdate(params) { }
async function hookPosUpdate(params, updated) { }

export const hooksCreate = { hookPreCreate, hookPosCreate };
export const hooksUpdate = { hookPreUpdate, hookPosUpdate };
```

### ValidationPipe
Todas as rotas com body devem ter:
```typescript
@UsePipes(new ValidationPipe({ 
  whitelist: true, 
  forbidNonWhitelisted: true, 
  transform: true 
}))
```

### Autenticação
Todas as rotas usam `@StudentAuth()` em vez de `@UserPermission()`.

## Notas de Implementação
- Seguir exatamente o padrão das features existentes
- Não criar novos tipos de hooks
- Separar responsabilidades em features distintas
- Usar GenericController para operações CRUD padrão
- Criar métodos específicos apenas quando necessário