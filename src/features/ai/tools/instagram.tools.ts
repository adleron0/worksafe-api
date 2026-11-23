import { HttpException } from '@nestjs/common';
import { KIND_LABEL, PostKind } from '../connectors/instagram.service';
import { positiveInt } from './actors';
import { ToolDefinition, ToolRefusal } from './tool.types';

/**
 * Instagram pelos bots (a Nina): ver a conta conectada, os posts agendados,
 * agendar post, story ou carrossel e cancelar. Agendar e cancelar saem para
 * fora: passam pelo cartão de confirmação.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description });

const KIND_IN: Record<string, PostKind> = { feed: 'feed', post: 'feed', story: 'story', stories: 'story', carrossel: 'carousel', carousel: 'carousel' };
const brDateTime = (date: Date) => date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpException && error.getStatus() < 500) throw new ToolRefusal(String((error.getResponse() as any)?.message ?? error.message));
    throw error;
  }
}

export const INSTAGRAM_TOOLS: ToolDefinition[] = [
  {
    name: 'instagram_conta',
    title: 'Olhando a conta do Instagram',
    description: 'Mostra se o Instagram da empresa está conectado (qual @), se a conexão está válida e quantos posts estão agendados. Use antes de agendar, para saber se dá.',
    inputSchema: obj({}),
    permissions: ['instagram_bots'],
    risk: 'read',
    botsOnly: true,
    run: async (ctx, _input, deps) => {
      const status = await deps.instagram.status(ctx.companyId);
      const agendados = await deps.prisma.ai_SocialPost.count({ where: { companyId: ctx.companyId, status: { in: ['scheduled', 'processing'] } } });
      if (!status.account) return { conectado: false, aviso: status.configured ? 'Peça para conectar o Instagram em Bots → Conectores.' : 'O app da Meta ainda não foi cadastrado no servidor: avise quem administra o sistema.' };
      return { conectado: status.account.status === 'connected', conta: `@${status.account.username}`, situacao: status.account.status === 'connected' ? 'conectado' : 'expirado: conectar de novo em Bots → Conectores', postsAgendados: agendados };
    },
  },
  {
    name: 'instagram_posts',
    title: 'Vendo os posts do Instagram',
    description: 'Lista os posts e stories agendados (próximos) ou os já publicados/que falharam, com data, legenda e link.',
    inputSchema: obj({ situacao: str('Quais mostrar (padrão: agendados)', { enum: ['agendados', 'publicados', 'falharam', 'cancelados'] }) }),
    permissions: ['instagram_bots'],
    risk: 'read',
    botsOnly: true,
    run: async (ctx, input, deps) => {
      const map: Record<string, string> = { agendados: 'upcoming', publicados: 'published', falharam: 'failed', cancelados: 'canceled' };
      const rows = await deps.instagram.list(ctx.companyId, { status: map[String(input.situacao ?? 'agendados')] ?? 'upcoming' });
      return {
        posts: rows.slice(0, 30).map((post) => ({ id: post.id, tipo: KIND_LABEL[post.kind as PostKind] ?? post.kind, quando: brDateTime(new Date(post.scheduledAt)), situacao: post.status, legenda: post.caption.slice(0, 160), imagens: post.media.length, link: post.permalink, erro: post.error })),
        total: rows.length,
      };
    },
  },
  {
    name: 'instagram_agendar_post',
    title: 'Preparando o post do Instagram',
    description: 'Agenda (ou publica já) um post no feed, um story ou um carrossel no Instagram da empresa. As imagens precisam estar no WorkSafe (use link_para_enviar_imagens / imagens_do_envio ou enviar_imagem_por_url antes). Story não tem legenda nem adesivos (a arte vai pronta). Sem "quando", publica no próximo minuto. A pessoa confirma no cartão.',
    inputSchema: obj({
      tipo: str('O que publicar', { enum: ['feed', 'story', 'carrossel'] }),
      imagens: { type: 'array', items: { type: 'string' }, description: 'URLs das imagens no WorkSafe (1 para feed e story; 2 a 10 para carrossel, na ordem)' },
      legenda: str('Legenda com hashtags (até 2.200 caracteres e 30 hashtags; ignorada no story)'),
      quando: str('Data e hora no horário de Brasília, ex.: 2026-11-28T18:30. Vazio = agora'),
    }, ['tipo', 'imagens']),
    permissions: ['instagram_bots'],
    risk: 'sensitive',
    botsOnly: true,
    prepare: async (ctx, input, deps) => {
      const kind = KIND_IN[String(input.tipo ?? '').toLowerCase()];
      if (!kind) throw new ToolRefusal('Escolha o tipo: feed, story ou carrossel');
      const data = await refusing(() => deps.instagram.validate(ctx.companyId, { kind, caption: input.legenda, media: input.imagens, scheduledAt: input.quando }));
      const status = await deps.instagram.status(ctx.companyId);
      if (status.account?.status !== 'connected') throw new ToolRefusal('A conexão com o Instagram expirou: peça para conectar de novo em Bots → Conectores');
      const now = !input.quando || data.scheduledAt.getTime() <= Date.now() + 60000;
      return {
        summary: `${now ? 'Publicar agora' : 'Agendar'} ${KIND_LABEL[kind]} no Instagram @${status.account.username}${now ? '' : ` para ${brDateTime(data.scheduledAt)}`}?`,
        details: [
          { label: 'Tipo', value: KIND_LABEL[kind] },
          { label: 'Quando', value: now ? 'agora' : brDateTime(data.scheduledAt) },
          { label: 'Imagens', value: data.media.join('\n') },
          ...(data.caption ? [{ label: 'Legenda', value: data.caption }] : []),
        ],
        payload: { kind, caption: data.caption, media: data.media, scheduledAt: data.scheduledAt.toISOString() },
      };
    },
    execute: async (ctx, payload, deps) => {
      const post = await refusing(() => deps.instagram.create(ctx, payload, ctx.botId ?? null));
      const when = new Date(post.scheduledAt);
      const now = when.getTime() <= Date.now() + 60000;
      return { message: now ? `${KIND_LABEL[post.kind as PostKind]} na fila: sai no Instagram em instantes.` : `${KIND_LABEL[post.kind as PostKind]} agendado para ${brDateTime(when)}.`, link: '/bots/conectores', data: { id: post.id } };
    },
  },
  {
    name: 'instagram_cancelar_post',
    title: 'Preparando o cancelamento do post',
    description: 'Cancela um post ou story agendado que ainda não foi publicado (use o id de instagram_posts). A pessoa confirma no cartão.',
    inputSchema: obj({ id: int('Id do post agendado') }, ['id']),
    permissions: ['instagram_bots'],
    risk: 'sensitive',
    botsOnly: true,
    prepare: async (ctx, input, deps) => {
      const id = positiveInt(input.id);
      const post = id ? await deps.prisma.ai_SocialPost.findFirst({ where: { id, companyId: ctx.companyId } }) : null;
      if (!post) throw new ToolRefusal('Post não encontrado');
      if (post.status !== 'scheduled') throw new ToolRefusal(post.status === 'published' ? 'Esse post já foi publicado' : 'Esse post não está agendado');
      return { summary: `Cancelar o ${KIND_LABEL[post.kind as PostKind]} de ${brDateTime(post.scheduledAt)}?`, details: post.caption ? [{ label: 'Legenda', value: post.caption.slice(0, 300) }] : [], payload: { id: post.id } };
    },
    execute: async (ctx, payload, deps) => {
      await refusing(() => deps.instagram.cancel(ctx.companyId, Number(payload.id)));
      return { message: 'Post cancelado.', link: '/bots/conectores' };
    },
  },
];
