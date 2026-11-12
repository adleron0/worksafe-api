-- Cadastro inicial de categorias e marcas da loja (para os filtros não
-- nascerem vazios) e vínculo dos produtos existentes, pelo nome exato.
-- Só preenche o que está vazio; tudo pode ser editado em Site → Categorias
-- da Loja / Marcas e no cadastro do produto. Marcas: as que aparecem nas
-- fotos/descrições dos produtos.

INSERT INTO "Site_ProductCategory" ("companyId", "name", "order")
SELECT c."companyId", v.name, v.ord
FROM (SELECT DISTINCT "companyId" FROM "Site_Products") c
CROSS JOIN (VALUES
  ('EPIs', 1),
  ('Ascensão e Descida', 2),
  ('Conectores e Ancoragem', 3),
  ('Cordas', 4),
  ('Polias', 5),
  ('Acessórios', 6)
) AS v(name, ord)
ON CONFLICT ("companyId", "name") DO NOTHING;

INSERT INTO "Site_ProductBrand" ("companyId", "name", "order")
SELECT c."companyId", v.name, v.ord
FROM (SELECT DISTINCT "companyId" FROM "Site_Products") c
CROSS JOIN (VALUES
  ('Ultra Safe', 1),
  ('Petzl', 2),
  ('Lory Safe', 3),
  ('Innova', 4)
) AS v(name, ord)
ON CONFLICT ("companyId", "name") DO NOTHING;

UPDATE "Site_Products" p
SET "categoryId" = cat.id
FROM (VALUES
  ('Capacete de Segurança Tipo III Classe A', 'EPIs'),
  ('Cinto Paraquedista 7Y', 'EPIs'),
  ('Talabarte em Y', 'EPIs'),
  ('Trava-Quedas para Corda ABS', 'EPIs'),
  ('Ascensor de Punho', 'Ascensão e Descida'),
  ('Descensor Autoblocante', 'Ascensão e Descida'),
  ('Lory Auto Blocante', 'Ascensão e Descida'),
  ('Mosquetão Oval de Aço', 'Conectores e Ancoragem'),
  ('Olhal de Ancoragem', 'Conectores e Ancoragem'),
  ('Fita Anelar de Ancoragem', 'Conectores e Ancoragem'),
  ('Corda de 11mm Para Trabalho em Altura e Resgate', 'Cordas'),
  ('Cordim', 'Cordas'),
  ('Polia Dupla', 'Polias'),
  ('Polia Simples', 'Polias'),
  ('Mochila de Equipamentos', 'Acessórios')
) AS v(product, category)
JOIN "Site_ProductCategory" cat ON cat.name = v.category
WHERE p.name = v.product AND cat."companyId" = p."companyId" AND p."categoryId" IS NULL;

UPDATE "Site_Products" p
SET "brandId" = br.id
FROM (VALUES
  ('Capacete de Segurança Tipo III Classe A', 'Ultra Safe'),
  ('Mosquetão Oval de Aço', 'Ultra Safe'),
  ('Fita Anelar de Ancoragem', 'Ultra Safe'),
  ('Polia Dupla', 'Ultra Safe'),
  ('Polia Simples', 'Ultra Safe'),
  ('Descensor Autoblocante', 'Petzl'),
  ('Lory Auto Blocante', 'Lory Safe'),
  ('Trava-Quedas para Corda ABS', 'Innova')
) AS v(product, brand)
JOIN "Site_ProductBrand" br ON br.name = v.brand
WHERE p.name = v.product AND br."companyId" = p."companyId" AND p."brandId" IS NULL;
