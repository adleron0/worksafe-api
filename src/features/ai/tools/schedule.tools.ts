import { positiveInt, text } from './actors';
import { ToolDefinition, ToolRefusal } from './tool.types';

/**
 * Agenda pela conversa: "Lia, toda segunda às 8h me manda as turmas com vaga".
 * Criar uma tarefa faz o assistente agir sozinho depois, então passa pelo
 * cartão de confirmação. As ferramentas usam as mesmas rotas da tela Agenda.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description });

const WEEKDAYS = ['', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];
const EVENTS: Record<string, string> = {
  proposta_aceita: 'quando uma proposta for aceita', os_mudou_etapa: 'quando uma OS mudar de etapa', documento_vencendo: 'quando um documento de funcionário for vencer',
  turma_lotada: 'quando uma turma lotar', despesa_sem_categoria: 'quando entrar uma despesa sem categoria', pagamento_recebido: 'quando um pagamento for recebido',
  inscricao_nova: 'quando uma inscrição for confirmada',
};

function describeWhen(input: Record<string, any>): string {
  switch (input.quando) {
    case 'uma_vez': return `uma vez, em ${String(input.dataHora).replace('T', ' às ').split(' às ').map((part, i) => (i ? part : part.split('-').reverse().join('/'))).join(' às ')}`;
    case 'a_cada_horas': return `a cada ${input.aCadaHoras} hora(s), das 8h às 18h, de segunda a sexta`;
    case 'diario': return `todo dia às ${input.hora ?? '07:00'}`;
    case 'semanal': return `toda ${(input.diasDaSemana ?? [1]).map((day: number) => WEEKDAYS[day]).join(', ')} às ${input.hora ?? '07:00'}`;
    case 'mensal': return `todo dia ${input.diaDoMes} do mês às ${input.hora ?? '07:00'}`;
    case 'evento': return EVENTS[input.evento] ?? input.evento;
    default: return '?';
  }
}

export const SCHEDULE_TOOLS: ToolDefinition[] = [
  {
    name: 'agendar_tarefa',
    title: 'Preparando a tarefa agendada',
    description: 'Agenda uma tarefa recorrente, única ou disparada por evento para um assistente (por padrão, você mesmo), que vai rodar sozinho com as permissões da pessoa e mandar o resultado para ela. Ex.: "toda segunda às 8h, categorize as despesas da semana". Ações que saem para fora continuam esperando confirmação. Precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({
      assistente: str('Chave ou nome do assistente (comercial, operacao, treinamentos, marketing, financeiro, gestao, ou Helena, Rafael...). Padrão: você.'),
      nome: str('Nome curto da tarefa'),
      oQueFazer: str('O pedido completo que o assistente vai executar a cada vez'),
      quando: str('Tipo de agenda', { enum: ['uma_vez', 'a_cada_horas', 'diario', 'semanal', 'mensal', 'evento'] }),
      dataHora: str('uma_vez: data e hora em Brasília (AAAA-MM-DDTHH:MM)'),
      hora: str('diario/semanal/mensal: hora (HH:MM, Brasília)'),
      diasDaSemana: { type: 'array', items: { type: 'integer' }, description: 'semanal: dias (1 = segunda ... 7 = domingo)' },
      diaDoMes: int('mensal: dia do mês (1 a 28)'),
      aCadaHoras: int('a_cada_horas: de quantas em quantas horas (1 a 10)'),
      evento: str('evento: qual', { enum: Object.keys(EVENTS) }),
      diasAntes: int('evento documento_vencendo: quantos dias antes (padrão 30)'),
      etapa: str('evento os_mudou_etapa: só para esta etapa (opcional)'),
      canais: { type: 'array', items: { type: 'string', enum: ['system', 'email', 'whatsapp'] }, description: 'Onde entregar o resultado (padrão: sistema)' },
    }, ['nome', 'oQueFazer', 'quando']),
    permissions: [], anyPermissions: ['usar_bots'], risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      const wanted = text(input.assistente, 40).toLowerCase();
      const bots = await deps.prisma.ai_Bot.findMany({ where: { companyId: ctx.companyId, inactiveAt: null, active: true }, select: { id: true, key: true, name: true, persona: true, permissionKey: true } });
      const bot = wanted
        ? bots.find((item) => item.key === wanted || item.persona?.toLowerCase() === wanted || item.name.toLowerCase() === wanted)
        : bots.find((item) => item.id === ctx.botId);
      if (!bot) throw new ToolRefusal(wanted ? `Não achei o assistente "${input.assistente}"` : 'Diga qual assistente vai fazer a tarefa');
      if (!ctx.permissions.includes(bot.permissionKey)) throw new ToolRefusal(`A pessoa não tem acesso a ${bot.persona ?? bot.name}`);
      const prompt = text(input.oQueFazer, 4000);
      if (prompt.length < 10) throw new ToolRefusal('Descreva melhor o que fazer');
      const frequency = { uma_vez: 'once', a_cada_horas: 'hourly', diario: 'daily', semanal: 'weekly', mensal: 'monthly', evento: 'event' }[input.quando as 'diario'];
      if (!frequency) throw new ToolRefusal('Escolha quando a tarefa roda');
      if (frequency === 'once' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(input.dataHora ?? ''))) throw new ToolRefusal('Informe dataHora no formato AAAA-MM-DDTHH:MM');
      if (frequency === 'event' && !EVENTS[input.evento]) throw new ToolRefusal('Escolha o evento');
      const body = {
        name: text(input.nome, 120), kind: 'ai', botId: bot.id, prompt, frequency,
        runAt: frequency === 'once' ? `${input.dataHora}:00-03:00` : undefined,
        time: /^\d{2}:\d{2}$/.test(String(input.hora ?? '')) ? input.hora : '07:00',
        daysOfWeek: frequency === 'weekly' ? input.diasDaSemana ?? [1] : undefined,
        dayOfMonth: frequency === 'monthly' ? input.diaDoMes : undefined,
        everyHours: frequency === 'hourly' ? input.aCadaHoras : undefined,
        eventType: frequency === 'event' ? input.evento : undefined,
        eventParams: frequency === 'event' ? { dias: input.diasAntes, etapa: input.etapa } : undefined,
        channels: Array.isArray(input.canais) && input.canais.length ? input.canais : ['system'],
      };
      return {
        summary: `Agendar para ${bot.persona ?? bot.name}: "${body.name}" — ${describeWhen(input)}?`,
        details: [
          { label: 'O que vai fazer', value: prompt.slice(0, 300) },
          { label: 'Entrega', value: body.channels.map((channel: string) => ({ system: 'no sistema', email: 'por e-mail', whatsapp: 'por WhatsApp' })[channel as 'email'] ?? channel).join(', ') },
          { label: 'Segurança', value: 'Roda com as suas permissões; envios, publicações e baixas continuam esperando sua confirmação.' },
        ],
        payload: body,
      };
    },
    execute: async (ctx, payload, deps) => {
      const row = await deps.api.call(ctx, 'POST', 'ai/schedules', { body: payload });
      return { message: `Tarefa "${row.name}" agendada${row.nextRunAt ? ` — primeira vez em ${new Date(row.nextRunAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })}` : ''}.`, link: '/bots/agenda' };
    },
  },
  {
    name: 'minhas_tarefas',
    title: 'Abrindo a agenda',
    description: 'As tarefas agendadas da pessoa (de todos os assistentes): o que fazem, quando rodam, a próxima vez, o último resultado e se estão pausadas.',
    inputSchema: obj({}),
    permissions: [], anyPermissions: ['usar_bots'], risk: 'read',
    run: async (ctx, _input, deps) => {
      const out = await deps.api.call(ctx, 'GET', 'ai/schedules');
      const bots = new Map((out.bots ?? []).map((bot: any) => [bot.id, bot.persona]));
      return {
        tarefas: (out.schedules ?? []).map((row: any) => ({
          id: row.id, nome: row.name, assistente: bots.get(row.botId) ?? null, tipo: row.kind === 'ai' ? 'assistente' : 'relatório de dados', quando: row.frequency,
          evento: row.eventLabel, proxima: row.nextRunAt, ultima: row.lastRunAt, ultimoResultado: row.lastStatus, ativa: row.active, pausa: row.pausedReason,
          dono: row.owner,
        })),
      };
    },
  },
  {
    name: 'pausar_tarefa',
    title: 'Pausando ou retomando a tarefa',
    description: 'Pausa ou retoma uma tarefa agendada (veja os ids em minhas_tarefas).',
    inputSchema: obj({ id: int('Id da tarefa'), pausar: { type: 'boolean', description: 'true pausa, false retoma' } }, ['id', 'pausar']),
    permissions: [], anyPermissions: ['usar_bots'], risk: 'draft',
    run: async (ctx, input, deps) => {
      const id = positiveInt(input.id);
      if (!id) throw new ToolRefusal('Informe a tarefa');
      const row = await deps.api.call(ctx, 'PATCH', `ai/schedules/${id}/${input.pausar ? 'pause' : 'resume'}`);
      return { id: row.id, nome: row.name, ativa: row.active, proxima: row.nextRunAt };
    },
  },
];
