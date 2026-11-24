import { ToolDefinition, ToolRefusal } from './tool.types';

/**
 * Memória de longo prazo do bot: fatos curtos que a pessoa ensina ou corrige.
 * O bot anota sozinho e avisa ("Anotei: …"); a pessoa desfaz pedindo para
 * esquecer ou apagando em Bots → Equipe → Memória.
 */
export const MEMORY_TOOLS: ToolDefinition[] = [
  {
    name: 'lembrar',
    title: 'Anotando na memória',
    description: 'Anota um fato curto para lembrar nas próximas conversas: uma preferência da pessoa, uma regra do trabalho dela ou uma correção que ela fez em você. Escreva só o fato, em uma frase de até 300 caracteres (ex.: "O fornecedor Posto Central vai sempre em Combustível."). Não anote dados que mudam (saldos, situações), senhas nem a conversa. Se o fato contradiz uma anotação da lista "O que você lembra", passe o número dela em substitui. Depois, diga em uma linha "Anotei: …".',
    inputSchema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'O fato, em até 300 caracteres.' },
        escopo: { type: 'string', enum: ['pessoa', 'empresa'], description: 'pessoa (padrão): vale só com esta pessoa. empresa: regra que vale para todos que usam você (só quem tem permissão; senão fica como pessoa).' },
        substitui: { type: 'number', description: 'Número (#) da anotação antiga que este fato substitui, se houver.' },
      },
      required: ['texto'],
    },
    permissions: ['usar_bots'],
    risk: 'draft',
    botsOnly: true,
    run: async (ctx, input, deps) => {
      if (!deps.memory) throw new ToolRefusal('A memória não está disponível agora');
      return deps.memory.remember(ctx, input);
    },
  },
  {
    name: 'esquecer',
    title: 'Apagando da memória',
    description: 'Apaga uma anotação da memória pelo número (#) da lista "O que você lembra", quando a pessoa pedir para esquecer ou disser que aquilo não vale mais.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Número (#) da anotação.' } },
      required: ['id'],
    },
    permissions: ['usar_bots'],
    risk: 'draft',
    botsOnly: true,
    run: async (ctx, input, deps) => {
      if (!deps.memory) throw new ToolRefusal('A memória não está disponível agora');
      return deps.memory.forget(ctx, input);
    },
  },
];

export const MEMORY_TOOL_NAMES = MEMORY_TOOLS.map((tool) => tool.name);
