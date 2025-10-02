# WorkSafe API

API REST desenvolvida em NestJS para gestão de plataforma de treinamentos de segurança do trabalho, emissão de certificados e gerenciamento multi-empresa.

## 📋 Descrição

O **WorkSafe API** é uma plataforma completa para gestão de treinamentos corporativos de segurança do trabalho, oferecendo:

- Sistema multi-empresa (multi-tenant)
- Gestão de cursos presenciais e online
- Emissão automática de certificados
- Controle de frequência e avaliações
- Integração com gateways de pagamento
- Gestão de alunos e instrutores
- Sistema de autenticação e autorização baseado em roles
- Sistema de cache com Redis
- Upload de arquivos para S3
- Webhooks e notificações por email
- Sistema de segurança contra ataques DDoS

## 🚀 Tecnologias

### Core
- **NestJS** (v11.1.6) - Framework Node.js
- **TypeScript** (5.8.3)
- **Prisma** (v6.16.1) - ORM
- **PostgreSQL** - Banco de dados relacional

### Segurança
- **JWT** (@nestjs/jwt) - Autenticação
- **Bcrypt** - Hash de senhas
- **Helmet** - Headers de segurança
- **Rate Limiting** - Proteção contra DDoS
- **Throttler** - Controle de taxa de requisições

### Infraestrutura
- **Redis** (ioredis) - Cache e sessões
- **AWS S3** (@aws-sdk/client-s3) - Armazenamento de arquivos
- **Sharp** - Processamento de imagens
- **Multer** - Upload de arquivos

### Integrações
- **Nodemailer** - Envio de emails
- **Axios** - Cliente HTTP
- **Swagger** - Documentação da API

## 📁 Estrutura do Projeto

```
worksafe-api/
├── src/
│   ├── auth/                    # Autenticação e autorização
│   │   ├── decorators/          # Decorators personalizados
│   │   ├── guards/              # Guards de autenticação
│   │   └── dtos/                # DTOs de autenticação
│   ├── common/                  # Módulos compartilhados
│   │   ├── cache/               # Sistema de cache
│   │   ├── security/            # Módulo de segurança
│   │   └── services/            # Serviços compartilhados
│   ├── features/                # Módulos de features
│   │   ├── company/             # Gestão de empresas
│   │   ├── users/               # Gestão de usuários
│   │   ├── training/            # Sistema de treinamentos
│   │   │   ├── course/          # Cursos
│   │   │   ├── classes/         # Turmas
│   │   │   ├── trainees/        # Alunos
│   │   │   ├── certificate/     # Certificados
│   │   │   ├── onlinecourses/   # Cursos online
│   │   │   ├── subscription/    # Inscrições
│   │   │   └── reviews/         # Avaliações
│   │   ├── student/             # Área do aluno
│   │   ├── gateway/             # Integrações de pagamento
│   │   ├── upload/              # Upload de arquivos
│   │   ├── email/               # Envio de emails
│   │   ├── clientes/            # Gestão de clientes
│   │   ├── area/                # Áreas e sub-áreas
│   │   └── dom_*/               # Domínios (estados, cidades, roles, etc)
│   ├── prisma/                  # Módulo Prisma
│   ├── utils/                   # Utilitários
│   ├── validators/              # Validadores personalizados
│   ├── queues/                  # Filas de processamento
│   └── main.ts                  # Bootstrap da aplicação
├── prisma/
│   ├── schema/                  # Schemas Prisma (modularizado)
│   ├── migrations/              # Migrações do banco
│   └── seed.ts                  # Seed do banco
├── test/                        # Testes
└── dist/                        # Build da aplicação
```

## 🏗️ Principais Módulos

### Autenticação (Auth)
- Login de usuários e alunos
- Recuperação de senha
- Guards JWT
- Decorators de autorização (@Roles, @Profiles, @Permissions)
- Sistema de permissões granulares

### Treinamentos (Training)
- **Cursos**: Gestão de cursos presenciais e online
- **Turmas**: Agendamento e gestão de turmas
- **Alunos**: Cadastro e acompanhamento
- **Certificados**: Geração automática com Fabric.js
- **Avaliações**: Sistema de provas e avaliações
- **Frequência**: Controle de presença
- **Aulas Online**: Lições, passos e progresso

### Empresas (Company)
- Multi-tenant
- Configurações personalizadas (cores, logos, domínios)
- Produtos e serviços
- Gateways de pagamento
- Email customizado

### Gateway de Pagamento
- Webhooks para processamento de pagamentos
- Registros financeiros
- Split de transações
- Cupons de desconto

### Segurança (Security)
- Rate limiting configurável por endpoint
- Detecção de ataques
- Blacklist/Whitelist de IPs
- Bloqueio automático após excesso de requisições
- Logs de segurança

### Cache
- Redis para cache de dados
- Cache de autenticação
- TTL configurável
- Invalidação automática

## ⚙️ Configuração

### Pré-requisitos

- Node.js >= 20.x
- PostgreSQL >= 14
- Redis (opcional, mas recomendado)
- AWS S3 (para upload de arquivos)

### Instalação

```bash
# Instalar dependências
npm install

# Copiar arquivo de ambiente
cp .env.example .env

# Configurar variáveis de ambiente
# Edite o arquivo .env com suas configurações
```

### Variáveis de Ambiente

```env
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/worksafe"

# JWT
JWT_SECRET=seu_secret_aqui
JWT_EXPIRES_IN=7d

# Redis (opcional)
REDIS_HOST=localhost
REDIS_PORT=6379

# AWS S3
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=seu_access_key
AWS_SECRET_ACCESS_KEY=seu_secret_key
AWS_S3_BUCKET=seu_bucket

# Email
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_USER=seu_email
MAIL_PASS=sua_senha

# Segurança
SECURITY_ENABLED=true
TRUST_PROXY_HOPS=1
SECURITY_MAX_REQUESTS=200

# Servidor
PORT=3000
ORIGIN_CORS=*
```

### Banco de Dados

```bash
# Executar migrações
npx prisma migrate dev

# Gerar cliente Prisma
npx prisma generate

# Executar seed (dados iniciais)
npm run seed
```

## 🏃 Executando o Projeto

```bash
# Desenvolvimento (watch mode)
npm run start:dev

# Produção
npm run build
npm run start:prod

# Debug
npm run start:debug
```

## 🧪 Testes

```bash
# Testes unitários
npm run test

# Testes e2e
npm run test:e2e

# Cobertura de testes
npm run test:cov
```

## 📚 Documentação Adicional

O projeto inclui documentações detalhadas sobre:

- **BACKEND_CERTIFICATE_GUIDE.md** - Guia completo de geração de certificados
- **AUTH-CACHE.md** - Documentação do sistema de cache de autenticação
- **CACHE.md** - Sistema de cache Redis
- **REDIS-PRODUCTION.md** - Configuração do Redis em produção
- **SELLER_CONFIG_STRUCTURE.md** - Estrutura de configuração de vendedores

## 🔐 Segurança

### Sistema de Proteção

O projeto implementa múltiplas camadas de segurança:

1. **Rate Limiting Global**: 100 requisições/minuto
2. **Rate Limiting Específico**:
   - `/classes`: 10 req/min
   - `/auth`: Configurável
   - `/upload`: Configurável
3. **Detecção de Ataques**: Middleware que analisa padrões de requisição
4. **Helmet**: Headers de segurança HTTP
5. **JWT**: Autenticação baseada em tokens
6. **CORS**: Configurável por ambiente

### Desabilitar Segurança (apenas desenvolvimento)

```env
SECURITY_ENABLED=false
```

## 🎯 Features Principais

### Para Empresas
- White label (logo, cores, domínio)
- Múltiplos produtos e serviços
- Dashboard de vendas
- Gestão de instrutores
- Relatórios financeiros

### Para Alunos
- Área do aluno
- Cursos online e presenciais
- Certificados digitais
- Acompanhamento de progresso
- Avaliações e frequência

### Para Administradores
- Gestão multi-empresa
- Controle de permissões
- Logs do sistema
- Configurações globais
- Webhooks e integrações

## 🛠️ Ferramentas CLI

```bash
# Gerar nova entidade
npm run gen:entity

# Executar seed
npm run seed

# Formatar código
npm run format

# Lint
npm run lint
```

## 📦 Deploy

### Build

```bash
npm run build
```

O build será gerado na pasta `dist/`.

### Produção

```bash
# Instalar apenas dependências de produção
npm ci --only=production

# Iniciar aplicação
npm run start:prod
```

## 🔄 Migrações

```bash
# Criar nova migração
npx prisma migrate dev --name nome_da_migracao

# Aplicar migrações em produção
npx prisma migrate deploy

# Reset do banco (desenvolvimento)
npx prisma migrate reset
```

## 📝 Convenções

### Commits
- `feat:` Nova funcionalidade
- `fix:` Correção de bug
- `docs:` Documentação
- `refactor:` Refatoração
- `test:` Testes
- `chore:` Manutenção

### Branches
- `main` - Produção
- `develop` - Desenvolvimento
- `feature/` - Novas features
- `fix/` - Correções

## 🤝 Contribuindo

1. Fork o projeto
2. Crie uma branch para sua feature (`git checkout -b feature/MinhaFeature`)
3. Commit suas mudanças (`git commit -m 'feat: Minha nova feature'`)
4. Push para a branch (`git push origin feature/MinhaFeature`)
5. Abra um Pull Request

## 📄 Licença

Este projeto é privado e proprietário da Adleron.

## 👥 Time

Desenvolvido por Adleron - Soluções em Tecnologia

---

**Versão**: 0.0.1
**Última atualização**: Outubro 2025
