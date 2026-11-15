import { HttpException } from '@nestjs/common';
import { CacheService } from 'src/common/cache/cache.service';
import { ImageIntakeService } from '../images/image-intake.service';
import { iso, positiveInt, text } from './actors';
import { ToolDefinition, ToolRefusal } from './tool.types';

/**
 * Imagens pelos bots e pelo MCP. O app de IA não consegue repassar o arquivo
 * que a pessoa anexou no chat; por isso o caminho principal é o link de envio
 * (a pessoa arrasta as imagens numa página do WorkSafe). URL pública e base64
 * ficam para quando o app tem o arquivo ou o endereço.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string) => ({ type: 'integer', description });

/** Quem pode subir imagens: quem mexe em blog ou turmas. */
export const IMAGE_PERMISSIONS = ['create_blog', 'update_blog', 'create_classes', 'update_classes'];

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpException && error.getStatus() < 500) throw new ToolRefusal(String((error.getResponse() as any)?.message ?? error.message));
    throw error;
  }
}

const present = (image: { id: number; url: string; name: string; width: number | null; height: number | null }) => ({ imagemId: image.id, url: image.url, nome: image.name, largura: image.width, altura: image.height });

async function evict(patterns: string[]) {
  const cache = new CacheService();
  for (const pattern of patterns) await cache.reset(pattern).catch(() => undefined);
}

export const IMAGE_TOOLS: ToolDefinition[] = [
  {
    name: 'link_para_enviar_imagens',
    title: 'Gerando o link para enviar imagens',
    description: 'Gera um link do WorkSafe onde a pessoa arrasta as imagens (vale 30 minutos). Use SEMPRE que a pessoa anexar ou quiser usar imagens que estão com ela (você não consegue repassar arquivos anexados no chat). Mostre o link, peça para ela avisar quando terminar e então use imagens_do_envio.',
    inputSchema: obj({ finalidade: str('Para quê, mostrado na página. Ex.: "Capa do post sobre NR-35"'), quantidade: int('Máximo de imagens (padrão 10)') }, ['finalidade']),
    permissions: [],
    anyPermissions: IMAGE_PERMISSIONS,
    risk: 'draft',
    run: async (ctx, input, deps) => {
      const link = await deps.images.createLink(ctx, input.finalidade, input.quantidade);
      return { envioId: link.id, link: link.url, valeAte: link.expiresAt, maximo: link.maxFiles, instrucao: 'Mostre o link para a pessoa e peça para avisar quando terminar de enviar.' };
    },
  },
  {
    name: 'imagens_do_envio',
    title: 'Pegando as imagens enviadas',
    description: 'As imagens que a pessoa já subiu pelo link de envio, com a URL de cada uma (use essas URLs no post, na turma etc.).',
    inputSchema: obj({ envioId: int('Id do envio (de link_para_enviar_imagens)') }, ['envioId']),
    permissions: [],
    anyPermissions: IMAGE_PERMISSIONS,
    risk: 'read',
    run: async (ctx, input, deps) => {
      const id = positiveInt(input.envioId);
      if (!id) throw new ToolRefusal('Informe o id do envio');
      const out = await refusing(() => deps.images.linkImages(ctx, id));
      return { ...out, imagens: out.imagens.map(present), aviso: out.imagens.length ? undefined : 'Nenhuma imagem enviada ainda: peça para a pessoa enviar pelo link.' };
    },
  },
  {
    name: 'enviar_imagem_por_url',
    title: 'Baixando a imagem',
    description: 'Sobe para o WorkSafe uma imagem que está num endereço público (https). Use quando a pessoa der o link de uma imagem. Devolve a URL dentro do sistema.',
    inputSchema: obj({ url: str('Endereço https da imagem'), nome: str('Nome da imagem') }, ['url']),
    permissions: [],
    anyPermissions: IMAGE_PERMISSIONS,
    risk: 'draft',
    run: async (ctx, input, deps) => present(await refusing(() => deps.images.fromUrl(ctx, input.url, text(input.nome, 120)))),
  },
  {
    name: 'enviar_imagem_base64',
    title: 'Subindo a imagem',
    description: 'Sobe uma imagem enviada em base64 (até 8 MB). Só use se você tiver o conteúdo real do arquivo (por exemplo, num ambiente com acesso a arquivos); nunca invente base64. Para imagens anexadas no chat, use link_para_enviar_imagens.',
    inputSchema: obj({ base64: str('Conteúdo da imagem em base64 (pode vir como data:image/...;base64,...)'), nome: str('Nome da imagem') }, ['base64']),
    permissions: [],
    anyPermissions: IMAGE_PERMISSIONS,
    risk: 'draft',
    run: async (ctx, input, deps) => present(await refusing(() => deps.images.fromBase64(ctx, input.base64, text(input.nome, 120)))),
  },
  {
    name: 'definir_imagem',
    title: 'Preparando a troca de imagem',
    description: 'Põe uma imagem (já no WorkSafe) como capa de um post do blog ou imagem de uma turma. Aparece no site: precisa da confirmação da pessoa no cartão.',
    inputSchema: obj({
      alvo: str('O que recebe a imagem', { enum: ['post', 'turma'] }),
      id: int('Id do post ou da turma'),
      imagemUrl: str('URL da imagem no WorkSafe (de imagens_do_envio ou enviar_imagem_*)'),
    }, ['alvo', 'id', 'imagemUrl']),
    permissions: [],
    anyPermissions: ['update_blog', 'update_classes'],
    risk: 'sensitive',
    prepare: async (ctx, input, deps) => {
      if (!ImageIntakeService.ownUrl(input.imagemUrl)) throw new ToolRefusal('Use uma imagem que já esteja no WorkSafe (suba antes com link_para_enviar_imagens ou enviar_imagem_por_url)');
      const id = positiveInt(input.id) ?? 0;
      if (input.alvo === 'post') {
        if (!ctx.permissions.includes('update_blog')) throw new ToolRefusal('Você não tem permissão para alterar posts do blog');
        const post = await deps.prisma.blog_Post.findFirst({ where: { id, companyId: ctx.companyId, inactiveAt: null } });
        if (!post) throw new ToolRefusal('Post não encontrado');
        return { summary: `Usar a imagem como capa do post "${post.title}"?`, details: [{ label: 'Situação', value: post.status === 'published' ? 'publicado (aparece no site na hora)' : 'rascunho' }, { label: 'Imagem', value: String(input.imagemUrl) }], payload: { alvo: 'post', id: post.id, url: input.imagemUrl } };
      }
      if (input.alvo === 'turma') {
        if (!ctx.permissions.includes('update_classes')) throw new ToolRefusal('Você não tem permissão para alterar turmas');
        const turma = await deps.prisma.courseClass.findFirst({ where: { id, companyId: ctx.companyId, inactiveAt: null } });
        if (!turma) throw new ToolRefusal('Turma não encontrada');
        return { summary: `Usar a imagem na turma "${turma.name}"${turma.initialDate ? ` (${iso(turma.initialDate)!.split('-').reverse().join('/')})` : ''}?`, details: [{ label: 'No site', value: turma.openClass && turma.active ? 'sim (aparece na hora)' : 'não' }, { label: 'Imagem', value: String(input.imagemUrl) }], payload: { alvo: 'turma', id: turma.id, url: input.imagemUrl } };
      }
      throw new ToolRefusal('Escolha o alvo: post ou turma');
    },
    execute: async (ctx, payload, deps) => {
      if (!ImageIntakeService.ownUrl(payload.url)) throw new ToolRefusal('Imagem inválida');
      if (payload.alvo === 'post') {
        const post = await deps.prisma.blog_Post.findFirst({ where: { id: payload.id, companyId: ctx.companyId } });
        if (!post) throw new ToolRefusal('Post não encontrado');
        await deps.prisma.blog_Post.update({ where: { id: post.id }, data: { coverImage: payload.url } });
        await evict(['blog/posts:*', 'blog-posts-public:*', 'blog-post-slug:*', 'cache:*/blog/posts*', 'cache:*/blog-posts-public*', 'cache:*/blog-post-slug*']);
        return { message: `Capa do post "${post.title}" trocada.`, link: '/blog/posts' };
      }
      const turma = await deps.prisma.courseClass.findFirst({ where: { id: payload.id, companyId: ctx.companyId } });
      if (!turma) throw new ToolRefusal('Turma não encontrada');
      await deps.prisma.courseClass.update({ where: { id: turma.id }, data: { imageUrl: payload.url } });
      await evict(['training-classes:*', 'cache:*/classes*']);
      return { message: `Imagem da turma "${turma.name}" trocada.`, link: `/treinamentos/turmas/${turma.id}` };
    },
  },
];
