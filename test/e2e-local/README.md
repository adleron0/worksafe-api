# E2E local — paridade com a versão anterior

Roda a API atual (porta 3100) e, opcionalmente, outra versão (3101) contra o
**mesmo banco local**, e compara listagens, contratos do front, escrita,
segurança e área do aluno. Não toca produção.

## Preparar (uma vez)

1. Banco local a partir de um dump (backup do S3 ou `pg_dump` da réplica):
   `createdb worksafe_e2e && pg_restore -d worksafe_e2e --no-owner --no-privileges <dump>`
2. **Neutralizar segredos na cópia local** (nenhum Asaas/SMTP real):
   ```sql
   UPDATE "CompanyGateWays" SET payload = jsonb_build_object('token','LOCAL-E2E-FAKE') WHERE payload IS NOT NULL;
   UPDATE "Company" SET email_conection = NULL;
   UPDATE "User" SET "sellerConfig" = NULL;
   ```
3. Senha conhecida para 3 usuários (super, admin, treinamento) e 1 aluno — só na cópia.
4. `test/e2e-local/e2e.env` (fora do git) com: `E_SUPER, E_ADMIN, E_TREINO, CNPJ, T_CPF, T_ID, LP_DOMAIN, PASS`.

## Rodar

API com `DATABASE_URI` apontando para `worksafe_e2e`, `REDIS_PORT` de um Redis
descartável, `SECURITY_ENABLED=false`, credenciais AWS falsas, `PORT=3100`.
Para a paridade, a versão de referência em `PORT=3101` com **outro** Redis.

    node test/e2e-local/e2e.mjs

Saída: tabela de paridade (✔ ids idênticos, ≠ diferente, ✖ erro) + checagens.

## O que NÃO cobre

Upload real ao S3, checkout/inscrição pública com cobrança no Asaas, envio de
e-mail, IA. Esses fluxos exigem credenciais reais e ficam para homologação.
