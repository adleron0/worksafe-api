import { ToolDefinition, ToolRefusal } from './tool.types';

/**
 * A equipe conversando entre si:
 * - pedir_ao_colega: o bot consulta um colega (que só pode consultar, sem criar
 *   nem alterar nada) e usa a resposta na dele. Um nível só: o colega não pede
 *   a um terceiro.
 * - passar_para_colega: o assunto é de outra área; abre a conversa com o colega
 *   já com o resumo, e a pessoa continua por lá.
 */
const COLEGA = { type: 'string', description: 'A área do colega, como aparece em "Sua equipe" (ex.: financeiro, comercial, operacao, treinamentos, marketing, gestao).' };

export const TEAM_TOOLS: ToolDefinition[] = [
  {
    name: 'pedir_ao_colega',
    title: 'Perguntando a um colega',
    label: (input) => `Perguntando ao colega (${String(input?.colega ?? '').slice(0, 30)})`,
    description: 'Pede a um colega da equipe uma informação da área dele que você não consegue consultar, e devolve a resposta dele para você montar a sua. O colega só consulta (não cria nem altera nada) e cada pedido custa uma conversa a mais: use só quando a informação for necessária, com um pedido claro e completo (período, filtros). Para a pessoa fazer algo na área do colega, use passar_para_colega.',
    inputSchema: {
      type: 'object',
      properties: { colega: COLEGA, pedido: { type: 'string', description: 'O que você precisa saber, com o contexto necessário. Ex.: "Quanto temos a pagar nos próximos 7 dias, por fornecedor?"' } },
      required: ['colega', 'pedido'],
    },
    permissions: ['equipe_bots'],
    risk: 'read',
    botsOnly: true,
    run: async (ctx, input, deps) => {
      if (!deps.team) throw new ToolRefusal('A equipe não está disponível agora');
      return deps.team.askColleague(ctx, input);
    },
  },
  {
    name: 'passar_para_colega',
    title: 'Passando para um colega',
    label: (input) => `Passando a conversa para o colega (${String(input?.colega ?? '').slice(0, 30)})`,
    description: 'Quando a pessoa quer fazer algo que é da área de outro colega: abre uma conversa nova com ele já com o resumo do que foi dito, e a pessoa abre pelo botão que aparece na tela. Escreva o resumo com tudo que o colega precisa (o pedido, números, nomes, datas), para a pessoa não repetir nada.',
    inputSchema: {
      type: 'object',
      properties: {
        colega: COLEGA,
        resumo: { type: 'string', description: 'O que a pessoa quer e o que já foi dito, em poucas linhas.' },
        titulo: { type: 'string', description: 'Título curto da conversa nova (opcional).' },
      },
      required: ['colega', 'resumo'],
    },
    permissions: ['equipe_bots'],
    risk: 'draft',
    botsOnly: true,
    run: async (ctx, input, deps) => {
      if (!deps.team) throw new ToolRefusal('A equipe não está disponível agora');
      return deps.team.handOff(ctx, input);
    },
  },
];

export const TEAM_TOOL_NAMES = TEAM_TOOLS.map((tool) => tool.name);
