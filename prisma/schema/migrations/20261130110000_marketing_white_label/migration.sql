-- Identidade visual da divulgação (white label).
-- O padrão para empresas novas passa a ser neutro (marca pelo logo do cadastro,
-- sem selos nem banco de fotos de terceiros). Quem já tinha configuração
-- continua igual: símbolo padrão na arte e banco de fotos ligado.
UPDATE "Marketing_Setting"
SET "data" = "data" || jsonb_build_object('marca', jsonb_build_object('tipo', 'padrao'), 'usarFotosPadrao', true),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE NOT ("data" ? 'marca');
