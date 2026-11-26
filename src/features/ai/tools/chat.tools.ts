import { ToolDefinition, ToolRefusal } from './tool.types';

/**
 * Ferramentas do atendimento das Conversas (WhatsApp): só existem dentro de
 * uma conversa que o bot está atendendo (triagem ou atende). Saem direto,
 * sem cartão, porque a empresa ligou esse modo no número.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const SECTOR_IDS = ['comercial', 'servicos', 'treinamentos', 'financeiro', 'operacao', 'geral'];

const inChat = (ctx: { chatConversation?: number }) => {
  if (!ctx.chatConversation) throw new ToolRefusal('Esta ferramenta só funciona dentro do atendimento das Conversas.');
};

export const CHAT_TOOLS: ToolDefinition[] = [
  {
    name: 'conversa_responder',
    title: 'Respondendo o cliente',
    description: 'Manda uma mensagem ao cliente nesta conversa (WhatsApp). Texto curto e cordial, no tom da empresa; sem inventar preço, data ou vaga. Uma mensagem por vez.',
    inputSchema: obj({ texto: str('A mensagem para o cliente') }, ['texto']),
    permissions: ['responder_conversas'],
    risk: 'sensitive',
    autoMode: true,
    botsOnly: true,
    prepare: async (ctx, input) => {
      inChat(ctx);
      const texto = String(input.texto ?? '').trim();
      if (!texto) throw new ToolRefusal('Escreva a mensagem.');
      if (texto.length > 1500) throw new ToolRefusal('Mensagem longa demais: resuma em poucas frases.');
      return { summary: 'Responder o cliente na conversa', details: [{ label: 'Mensagem', value: texto }], payload: { texto }, auto: true };
    },
    execute: async (ctx, payload, deps) => {
      if (!deps.chat) throw new ToolRefusal('Atendimento indisponível agora.');
      const out = await deps.chat.reply(ctx, String(payload.texto));
      return { message: out.message };
    },
  },
  {
    name: 'conversa_encaminhar',
    title: 'Passando para a equipe',
    description: 'Passa a conversa para uma pessoa da equipe: escolhe o setor certo e deixa um resumo de uma ou duas frases para quem for atender. Depois disso o bot para de responder nesta conversa.',
    inputSchema: obj({
      setor: str('Setor que deve atender', { enum: SECTOR_IDS }),
      resumo: str('O que o cliente quer, em uma ou duas frases'),
      motivo: str('Por que passou (ex.: pediu desconto, pediu para falar com alguém, não sei responder)'),
    }, ['resumo']),
    permissions: ['responder_conversas'],
    risk: 'sensitive',
    autoMode: true,
    botsOnly: true,
    prepare: async (ctx, input) => {
      inChat(ctx);
      const setor = input.setor ? String(input.setor) : undefined;
      if (setor && !SECTOR_IDS.includes(setor)) throw new ToolRefusal(`Setor inválido. Use um destes: ${SECTOR_IDS.join(', ')}`);
      return { summary: 'Passar a conversa para a equipe', details: [{ label: 'Resumo', value: String(input.resumo ?? '') }], payload: { setor, resumo: String(input.resumo ?? '').slice(0, 600), motivo: String(input.motivo ?? '').slice(0, 300) }, auto: true };
    },
    execute: async (ctx, payload, deps) => {
      if (!deps.chat) throw new ToolRefusal('Atendimento indisponível agora.');
      const out = await deps.chat.route(ctx, payload as { setor?: string; resumo?: string; motivo?: string });
      return { message: out.message };
    },
  },
];

/**
 * Conversas pelo MCP (Claude do dono) e na área de Bots: listar e ler as
 * conversas que a pessoa enxerga e preparar uma mensagem — que só sai depois
 * de confirmada em Bots → Ações pendentes. Os bots que atendem clientes não
 * recebem estas (nunca leem a conversa de outro cliente).
 */
const VIEW = ['view_conversas', 'todas_conversas', 'canais_conversas'];

export const CHAT_MCP_TOOLS: ToolDefinition[] = [
  {
    name: 'conversas_listar',
    title: 'Consultando as conversas',
    description: 'Lista as conversas de WhatsApp/Instagram que a pessoa vê na caixa de entrada: contato, cliente, número, setor, quem atende, não lidas e a última mensagem. Caixas: abertas (padrão), minhas, sem_dono, nao_lidas, resolvidas. Busca por nome ou telefone.',
    inputSchema: obj({
      caixa: str('Qual caixa', { enum: ['abertas', 'minhas', 'sem_dono', 'nao_lidas', 'resolvidas'] }),
      busca: str('Nome, telefone ou texto para filtrar'),
      limite: { type: 'number', description: 'Quantas conversas (até 50; padrão 20)' },
    }),
    permissions: [],
    anyPermissions: VIEW,
    risk: 'read',
    run: async (ctx, input, deps) => {
      if (!deps.chat?.list) throw new ToolRefusal('Conversas indisponíveis agora.');
      return deps.chat.list(ctx, input);
    },
  },
  {
    name: 'conversas_ler',
    title: 'Lendo a conversa',
    description: 'Lê as últimas mensagens de uma conversa (id da lista): quem escreveu, quando e o texto (áudios aparecem transcritos quando houver). Notas internas da equipe também aparecem.',
    inputSchema: obj({ conversa: { type: 'number', description: 'Id da conversa' }, limite: { type: 'number', description: 'Quantas mensagens (até 60; padrão 30)' } }, ['conversa']),
    permissions: [],
    anyPermissions: VIEW,
    risk: 'read',
    run: async (ctx, input, deps) => {
      if (!deps.chat?.read) throw new ToolRefusal('Conversas indisponíveis agora.');
      const id = Number(input.conversa);
      if (!(id > 0)) throw new ToolRefusal('Informe o id da conversa (veja em conversas_listar).');
      return deps.chat.read(ctx, id, Number(input.limite) || 30);
    },
  },
  {
    name: 'conversas_enviar_mensagem',
    title: 'Preparando mensagem ao cliente',
    description: 'Prepara uma mensagem para o cliente numa conversa existente (id da lista). Não sai na hora: a pessoa confirma em Bots → Ações pendentes, e depois a mensagem entra na fila do número, com o ritmo e os limites dele. Não serve para começar conversa com quem nunca escreveu.',
    inputSchema: obj({ conversa: { type: 'number', description: 'Id da conversa' }, texto: str('A mensagem para o cliente') }, ['conversa', 'texto']),
    permissions: ['responder_conversas'],
    anyPermissions: VIEW,
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      if (!deps.chat?.check) throw new ToolRefusal('Conversas indisponíveis agora.');
      const id = Number(input.conversa);
      const texto = String(input.texto ?? '').trim();
      if (!(id > 0)) throw new ToolRefusal('Informe o id da conversa (veja em conversas_listar).');
      if (!texto) throw new ToolRefusal('Escreva a mensagem.');
      if (texto.length > 2000) throw new ToolRefusal('Mensagem longa demais: resuma.');
      const who = await deps.chat.check(ctx, id);
      return { summary: `Mandar mensagem para ${who.contato}`, details: [{ label: 'Para', value: `${who.contato} (${who.numero})` }, { label: 'Mensagem', value: texto }], payload: { conversa: id, texto } };
    },
    execute: async (ctx, payload, deps) => {
      if (!deps.chat?.send) throw new ToolRefusal('Conversas indisponíveis agora.');
      return deps.chat.send(ctx, Number(payload.conversa), String(payload.texto));
    },
  },
];
