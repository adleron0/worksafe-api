-- Financeiro pelo assistente: o Bot Financeiro deixa de ser só consulta e ganha
-- as ferramentas do financeiro novo; o de Gestão troca as consultas antigas
-- pelas do livro (fluxo de caixa e DRE). Instruções e atalhos só mudam em bot
-- que ninguém editou (versão 1).
UPDATE "Ai_Bot" SET "tools" = '["fin_resumo","fin_contas_a_pagar","fin_contas_a_receber","fin_fluxo_de_caixa","fin_dre","fin_plano_de_contas","fin_cadastros","fin_recorrencias","fin_transferencias","fin_classificacao_padrao","fin_cadastrar_despesa","fin_editar_conta_a_pagar","fin_cadastrar_conta_a_receber","fin_editar_conta_a_receber","fin_categorizar","fin_salvar_conta_do_plano","fin_mover_conta_do_plano","fin_ativar_inativar","fin_salvar_centro_de_custo","fin_salvar_fornecedor","fin_salvar_conta_bancaria","fin_salvar_recorrencia","fin_encerrar_recorrencia","fin_definir_classificacao_padrao","fin_dar_baixa","fin_estornar_baixa","fin_transferir_entre_contas","fin_excluir_lancamentos","listar_pedidos_de_compra","minha_esteira"]'::jsonb, "description" = 'Contas a pagar e a receber, categorias, cadastros e relatórios (fluxo de caixa, DRE).', "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'financeiro';

UPDATE "Ai_Bot" SET "instructions" = 'Você é o Bot Financeiro. Cuida do que entra e do que sai: contas a pagar e a receber, categorização pelo plano de contas e centros de custo, fornecedores, contas bancárias, recorrências e relatórios (fluxo de caixa e DRE).
- Antes de categorizar ou cadastrar, consulte o plano de contas e os cadastros para usar os ids certos. Despesa vai em conta de despesa; receita em conta de receita.
- Fornecedor que não existe: cadastre (fin_salvar_fornecedor) antes de lançar a despesa.
- Baixa, estorno, transferência e exclusão só PREPARAM um cartão: a pessoa confirma.
- Em relatórios, comece pelo que pede atenção (vencidos, saldo negativo, margem caindo) e mostre os totais em tabela curta.
- Nunca invente valores ou datas: pergunte o que faltar.', "shortcuts" = '[{"label":"Resumo financeiro","prompt":"Como está o financeiro hoje? Saldos, vencidos e o que vence na semana."},{"label":"Lançar despesa","prompt":"Quero lançar uma despesa."},{"label":"Sem categoria","prompt":"Quais lançamentos deste mês estão sem categoria? Sugira a categoria de cada um."},{"label":"DRE do mês","prompt":"Mostre a DRE deste mês comparando com o mês passado."}]'::jsonb, "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'financeiro' AND "version" = 1;

UPDATE "Ai_Bot" SET "tools" = '["minha_esteira","listar_propostas","listar_acompanhamentos","listar_os","resultado_obras","quem_esta_livre","documentos_vencendo","listar_turmas","fin_resumo","fin_contas_a_receber","fin_contas_a_pagar","fin_fluxo_de_caixa","fin_dre","listar_pedidos_de_compra"]'::jsonb, "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'gestao' AND "tools" @> '["contas_a_pagar"]'::jsonb;
