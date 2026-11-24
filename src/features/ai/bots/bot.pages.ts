/**
 * Páginas do sistema onde um bot pode aparecer (rostinhos no topo + janela
 * rápida). As chaves espelham o catálogo do front (bots/-shared/pages.ts),
 * que diz a que rotas cada uma corresponde. Plano: worksafe/bots-nas-paginas-planejamento.
 */
export const PAGE_KEYS = [
  'home',
  'comercial', 'propostas', 'negociacoes', 'contratos', 'clientes',
  'servicos',
  'treinamentos', 'turmas', 'divulgacao',
  'financeiro', 'faturar',
  'rh', 'alocacao',
  'estoque', 'compras', 'equipamentos', 'locacoes',
  'blog', 'site', 'arquivos',
] as const;

/** Onde cada bot padrão aparece, pela área (key). Bot criado na tela nasce sem página. */
export const DEFAULT_PAGES: Record<string, string[]> = {
  gestao: ['home'],
  comercial: ['comercial', 'clientes'],
  operacao: ['servicos'],
  rh: ['rh'],
  suprimentos: ['estoque', 'compras', 'equipamentos', 'locacoes'],
  treinamentos: ['treinamentos'],
  marketing: ['blog', 'site', 'divulgacao'],
  financeiro: ['financeiro'],
};

export const defaultPagesFor = (key: string): string[] => DEFAULT_PAGES[key] ?? [];

/** Lista de páginas vinda da tela: só chaves conhecidas, sem repetir. */
export function cleanPages(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const known = new Set<string>(PAGE_KEYS);
  return [...new Set(value.map(String))].filter((key) => known.has(key));
}

/** Onde a pessoa estava quando mandou a mensagem (vem da janela rápida). */
export interface PageContext { label: string; path: string; entity?: string; id?: number; title?: string }

const text = (value: unknown, max: number) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[[\]]/g, '').trim().slice(0, max);

/** Valida o contexto que a tela manda (JSON no campo "page" do envio). Inválido = ignora. */
export function cleanPageContext(raw: unknown): PageContext | null {
  let value: any = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return null;
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const label = text(value.label, 60);
  const path = String(value.path ?? '').trim().slice(0, 200);
  if (!label || !/^\/[\w\-/.]*$/.test(path)) return null;
  const out: PageContext = { label, path };
  const entity = String(value.entity ?? '').trim();
  if (/^[a-z_]{2,30}$/.test(entity)) {
    out.entity = entity;
    const id = Number(value.id);
    if (Number.isInteger(id) && id > 0) out.id = id;
    const title = text(value.title, 120);
    if (title) out.title = title;
  }
  return out;
}

/** A linha que vai junto da mensagem para o modelo. O título vem de dados: vai entre aspas, como dado. */
export function pageLine(page: PageContext): string {
  const record = page.entity ? `; registro aberto: ${page.entity}${page.id ? ` id ${page.id}` : ''}${page.title ? ` "${page.title}"` : ''}` : '';
  return `[Tela de onde a pessoa escreveu: ${page.label} (${page.path})${record}]`;
}
