#!/bin/zsh
# API local para a homologação no sandbox. Ver homolog-asaas.mjs.
cd "$(dirname "$0")/../.."
set -a; source .env; set +a
export DATABASE_URI="postgresql://adleron@localhost:5432/worksafe_e2e"
export REDIS_HOST=localhost REDIS_PORT=6390 PORT=3100
export SECURITY_ENABLED=false ORIGIN_CORS="*"
export AWS_ACCESS_KEY_ID=E2EFAKE AWS_SECRET_ACCESS_KEY=E2EFAKE
export BASE_SETUP=development
# Em development o AsaasService usa esta chave global, não a da empresa.
export TOKEN_ASAAS_SANDBOX="$(tr -d '\n\r ' < .asaas-sandbox.key)"
# example.com é reservado (RFC 2606): o Asaas aceita a URL e os eventos do
# sandbox nunca chegam à API real. (.invalid é recusado pelo Asaas.)
export WEBHOOK_URL="https://example.com"
unset ASAAS_WEBHOOK_TOKEN
exec node dist/src/main
