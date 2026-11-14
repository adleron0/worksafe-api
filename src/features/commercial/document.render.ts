import { createHash } from 'crypto';
import * as sanitizeHtml from 'sanitize-html';
import { BRAND_BLOCKS, BlockData, Brand, ProposalImage, Schedule, textOnColor } from './document.blocks';

/**
 * Montagem do documento da proposta: funções puras (sem banco nem Nest),
 * para poderem ser testadas sozinhas.
 */

export const ITEMS_MODES = ['detalhado', 'por_secao', 'global'] as const;
export type ItemsMode = (typeof ITEMS_MODES)[number];

/** Tudo que o documento mostra ao cliente. Nunca leva custo, margem, imposto ou comissão. */
export interface DocumentData {
  company: { name: string; corporateName: string; cnpj: string; addressLines?: string[] };
  customer: { name: string; corporateName: string; cnpj: string; email?: string; phone?: string; addressLines?: string[] };
  contactName: string | null; sellerName: string | null;
  /** contato desta proposta: quando preenchido, é o e-mail e o telefone que aparecem no documento */
  contactEmail?: string | null; contactPhone?: string | null;
  number: string; title: string; description: string | null;
  date: Date; validUntil: string | null; workDays: number; total: number;
  sections: Array<{ title: string; show: boolean; value: number; items: Array<{ description: string; unit: string | null; quantity: number; value: number; show: boolean; detail?: string }> }>;
  installments: Array<{ description: string | null; value: number; dueRule: string; dueDate: string | null; dueDays: number | null }>;
  /** identidade da empresa, imagens da proposta e contato do responsável (blocos de capa, quem somos, imagens...) */
  brand?: Brand;
  images?: ProposalImage[];
  schedule?: Schedule;
  kind?: 'servico' | 'treinamento' | 'misto';
  seller?: { name: string | null; email: string | null; phone: string | null };
}

export interface TermText { id: number; title: string; body: string }

// ---------------------------------------------------------------- texto

export const clean = (value: unknown, max = 255) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
export const blank = (value: unknown) => value === undefined || value === null || value === '';
export const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const money = (value: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
export const dateBr = (value: Date | string | null | undefined) => {
  if (!value) return '';
  const iso = typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
  return iso.split('-').reverse().join('/');
};
export const cnpjBr = (cnpj: string) => (cnpj?.length === 14 ? cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : cnpj ?? '');
export const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * O corpo vem do editor de texto rico e é mostrado em página pública: só
 * passa formatação de texto. Nada de script, iframe, evento ou estilo solto.
 */
export function sanitizeBody(html: unknown): string {
  return sanitizeHtml(String(html ?? ''), {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'h1', 'h2', 'h3', 'h4', 'ol', 'ul', 'li', 'blockquote', 'a', 'span', 'img', 'hr'],
    allowedAttributes: { a: ['href', 'target', 'rel'], img: ['src', 'alt', 'width', 'height'], '*': ['style', 'class'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['https'] },
    allowedClasses: { '*': [/^ql-[a-z0-9-]+$/] },
    allowedStyles: { '*': {
      color: [/^#[0-9a-f]{3,8}$/i, /^rgb\((\s*\d{1,3}\s*,){2}\s*\d{1,3}\s*\)$/],
      'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgb\((\s*\d{1,3}\s*,){2}\s*\d{1,3}\s*\)$/],
      'text-align': [/^(left|right|center|justify)$/],
    } },
    transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) },
  }).slice(0, 200000);
}

const UNITS = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const HUNDREDS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
function below1000(n: number): string {
  if (n === 100) return 'cem';
  const parts: string[] = [];
  if (n >= 100) parts.push(HUNDREDS[Math.floor(n / 100)]);
  const rest = n % 100;
  if (rest > 0 && rest < 20) parts.push(UNITS[rest]);
  else if (rest >= 20) parts.push(TENS[Math.floor(rest / 10)] + (rest % 10 ? ` e ${UNITS[rest % 10]}` : ''));
  return parts.join(' e ');
}
function integerInWords(n: number): string {
  if (n === 0) return 'zero';
  const groups: Array<[number, string, string]> = [[1e9, 'bilhão', 'bilhões'], [1e6, 'milhão', 'milhões'], [1e3, 'mil', 'mil'], [1, '', '']];
  const parts: Array<{ text: string; value: number }> = [];
  let rest = n;
  for (const [size, singular, plural] of groups) {
    const count = Math.floor(rest / size);
    rest %= size;
    if (!count) continue;
    const words = size === 1e3 && count === 1 ? 'mil' : `${below1000(count)}${size > 1 ? ` ${count === 1 ? singular : plural}` : ''}`;
    parts.push({ text: words, value: count });
  }
  // "e" antes do último grupo quando ele é menor que 100 ou centena redonda
  return parts.map((part, index) => {
    if (index === 0) return part.text;
    const last = index === parts.length - 1;
    return `${last && (part.value < 100 || part.value % 100 === 0) ? ' e ' : ', '}${part.text}`;
  }).join('');
}
/** 20589.11 → "vinte mil, quinhentos e oitenta e nove reais e onze centavos". */
export function moneyInWords(value: number): string {
  const cents = Math.round(Math.abs(value) * 100);
  const reais = Math.floor(cents / 100), rest = cents % 100;
  const parts: string[] = [];
  if (reais > 0) parts.push(`${integerInWords(reais)} ${reais === 1 ? 'real' : reais % 1e6 === 0 ? 'de reais' : 'reais'}`);
  if (rest > 0) parts.push(`${integerInWords(rest)} ${rest === 1 ? 'centavo' : 'centavos'}`);
  return parts.length ? parts.join(' e ') : 'zero real';
}

export function validCpf(raw: unknown): boolean {
  const cpf = String(raw ?? '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (length: number) => {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += Number(cpf[i]) * (length + 1 - i);
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

// ---------------------------------------------------------------- blocos

const TABLE = 'width:100%;border-collapse:collapse;margin:8px 0;font-size:0.95em';
const TH = 'text-align:left;padding:6px 8px;border-bottom:2px solid #999';
const TD = 'padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top';
const RIGHT = ';text-align:right;white-space:nowrap';
const quantity = (value: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(value);

/** Aparência das tabelas do modelo de orçamento: faixa na cor da marca e linhas alternadas. */
interface Classic { color: string; on: string }
const PRINT = '-webkit-print-color-adjust:exact;print-color-adjust:exact';
const cTable = 'width:100%;border-collapse:separate;border-spacing:1px 1px;margin:4px 0 8px;font-size:0.9em';
const cTh = (c: Classic) => `text-align:left;padding:5px 8px;background:${c.color};color:${c.on};font-weight:400;letter-spacing:.03em;${PRINT}`;
const cTd = (c: Classic, tinted: boolean) => `padding:5px 8px;vertical-align:top${tinted ? `;background:${c.color}1A;${PRINT}` : ''}`;

function classicItemsTable(data: DocumentData, mode: ItemsMode, c: Classic): string {
  const sections = data.sections.filter((section) => section.show);
  const rows: string[] = [];
  const detailed = mode === 'detalhado';
  const columns = detailed ? 4 : mode === 'por_secao' ? 2 : 1;
  for (const section of sections) {
    const items = section.items.filter((item) => item.show);
    if (detailed) {
      if (sections.length > 1) rows.push(`<tr><td colspan="4" style="${cTd(c, false)};font-weight:700;padding-top:8px">${escape(section.title)}</td></tr>`);
      for (const item of items) {
        const unit = item.quantity ? item.value / item.quantity : item.value;
        rows.push(`<tr><td style="${cTd(c, true)}">${escape(item.description)}${item.detail ? `<br><span style="color:#555;font-size:0.92em">${escape(item.detail)}</span>` : ''}</td>`
          + `<td style="${cTd(c, false)}${RIGHT}">${quantity(item.quantity)}${item.unit ? ` <span style="color:#555">${escape(item.unit)}</span>` : ''}</td>`
          + `<td style="${cTd(c, true)}${RIGHT}">${money(unit)}</td><td style="${cTd(c, false)}${RIGHT}">${money(item.value)}</td></tr>`);
      }
      if (sections.length > 1) rows.push(`<tr><td colspan="3" style="${cTd(c, false)}${RIGHT}">Subtotal:</td><td style="${cTd(c, true)}${RIGHT}">${money(section.value)}</td></tr>`);
    } else if (mode === 'por_secao') {
      rows.push(`<tr><td style="${cTd(c, true)}">${escape(section.title)}</td><td style="${cTd(c, false)}${RIGHT}">${money(section.value)}</td></tr>`);
    } else {
      const names = items.map((item) => `<li>${escape(item.description)}${item.detail ? ` <span style="color:#555">(${escape(item.detail)})</span>` : ''}</li>`).join('');
      rows.push(`<tr><td style="${cTd(c, true)}"><strong>${escape(section.title)}</strong>${names ? `<ul style="margin:4px 0 0 18px">${names}</ul>` : ''}</td></tr>`);
    }
  }
  const total = columns === 1
    ? `<tr><td style="${cTd(c, false)}${RIGHT}">Total: <strong>${money(data.total)}</strong></td></tr>`
    : `<tr><td colspan="${columns - 1}" style="${cTd(c, false)}${RIGHT}">Total:</td><td style="${cTd(c, true)}${RIGHT};font-weight:700">${money(data.total)}</td></tr>`;
  const head = detailed
    ? `<tr><th style="${cTh(c)}">Descrição do serviço</th><th style="${cTh(c)}${RIGHT}">Quantidade</th><th style="${cTh(c)}${RIGHT}">Valor unit.</th><th style="${cTh(c)}${RIGHT}">Valor total</th></tr>`
    : mode === 'por_secao' ? `<tr><th style="${cTh(c)}">Descrição do serviço</th><th style="${cTh(c)}${RIGHT}">Valor total</th></tr>`
      : `<tr><th style="${cTh(c)}">Descrição do serviço</th></tr>`;
  return `<table style="${cTable}"><thead>${head}</thead><tbody>${rows.join('')}${total}</tbody></table>`;
}

function classicPaymentTable(data: DocumentData, c: Classic): string {
  if (!data.installments.length) return '<p>A combinar.</p>';
  const many = data.installments.length > 1;
  const rows = data.installments.map((inst, index) =>
    `<tr><td style="${cTd(c, true)}">${many ? `${index + 1}` : 'Única'}</td><td style="${cTd(c, false)}">${escape(dueText(inst))}${inst.description && inst.description !== dueText(inst) ? ` <span style="color:#555">— ${escape(inst.description)}</span>` : ''}</td>`
    + `<td style="${cTd(c, true)}${RIGHT}">${money(inst.value)}</td></tr>`);
  return `<table style="${cTable}"><thead><tr><th style="${cTh(c)}">Parcela</th><th style="${cTh(c)}">Vencimento</th><th style="${cTh(c)}${RIGHT}">Valor</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

/** Termos no modelo de orçamento: um traço, o título em caixa alta e o texto em letra menor. */
const classicTermsBlock = (terms: TermText[]) => terms.map((term) =>
  `<div data-block="termo" style="border-top:1px solid #999;margin-top:14px;padding-top:8px;font-size:.9em;line-height:1.5">`
  + `<div style="font-size:.95em;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin:0 0 6px">${escape(term.title)}</div>${term.body}</div>`).join('');

function itemsTable(data: DocumentData, mode: ItemsMode): string {
  const sections = data.sections.filter((section) => section.show);
  const rows: string[] = [];
  if (mode === 'global') {
    for (const section of sections) {
      const names = section.items.filter((item) => item.show).map((item) => `<li>${escape(item.description)}${item.detail ? ` <span style="color:#555">(${escape(item.detail)})</span>` : ''}</li>`).join('');
      rows.push(`<tr><td style="${TD}"><strong>${escape(section.title)}</strong>${names ? `<ul style="margin:4px 0 0 18px">${names}</ul>` : ''}</td></tr>`);
    }
    rows.push(`<tr><td style="${TD}${RIGHT};font-weight:bold">Valor total: ${money(data.total)}</td></tr>`);
    return `<table style="${TABLE}"><tbody>${rows.join('')}</tbody></table>`;
  }
  const detailed = mode === 'detalhado';
  for (const section of sections) {
    if (detailed) {
      rows.push(`<tr><td colspan="4" style="${TD};background:#f3f3f3;font-weight:bold">${escape(section.title)}</td></tr>`);
      for (const item of section.items.filter((entry) => entry.show)) {
        rows.push(`<tr><td style="${TD}">${escape(item.description)}${item.detail ? `<br><span style="color:#555;font-size:0.9em">${escape(item.detail)}</span>` : ''}</td>`
          + `<td style="${TD}${RIGHT}">${quantity(item.quantity)}</td><td style="${TD}">${escape(item.unit ?? '')}</td><td style="${TD}${RIGHT}">${money(item.value)}</td></tr>`);
      }
      rows.push(`<tr><td colspan="3" style="${TD}${RIGHT}">Subtotal — ${escape(section.title)}</td><td style="${TD}${RIGHT};font-weight:bold">${money(section.value)}</td></tr>`);
    } else {
      rows.push(`<tr><td style="${TD}">${escape(section.title)}</td><td style="${TD}${RIGHT}">${money(section.value)}</td></tr>`);
    }
  }
  const span = detailed ? 3 : 1;
  rows.push(`<tr><td colspan="${span}" style="${TD}${RIGHT};font-weight:bold">Valor total</td><td style="${TD}${RIGHT};font-weight:bold">${money(data.total)}</td></tr>`);
  const head = detailed
    ? `<tr><th style="${TH}">Descrição</th><th style="${TH}${RIGHT}">Qtd.</th><th style="${TH}">Un.</th><th style="${TH}${RIGHT}">Valor</th></tr>`
    : `<tr><th style="${TH}">Descrição</th><th style="${TH}${RIGHT}">Valor</th></tr>`;
  return `<table style="${TABLE}"><thead>${head}</thead><tbody>${rows.join('')}</tbody></table>`;
}

function dueText(inst: DocumentData['installments'][number]): string {
  if (inst.dueRule === 'data_fixa') return `em ${dateBr(inst.dueDate)}`;
  const event = inst.dueRule === 'dias_apos_aceite' ? 'o aceite desta proposta' : inst.dueRule === 'dias_apos_conclusao' ? 'a conclusão' : 'a emissão da nota fiscal';
  const days = inst.dueDays ?? 0;
  if (days === 0) return inst.dueRule === 'dias_apos_aceite' ? 'no aceite desta proposta' : inst.dueRule === 'dias_apos_conclusao' ? 'na conclusão' : 'na emissão da nota fiscal';
  return `${days} dia${days === 1 ? '' : 's'} após ${event}`;
}

function paymentTable(data: DocumentData): string {
  if (!data.installments.length) return '<p>A combinar.</p>';
  const rows = data.installments.map((inst, index) =>
    `<tr><td style="${TD}">${escape(inst.description || (data.installments.length === 1 ? 'Pagamento único' : `Parcela ${index + 1} de ${data.installments.length}`))}</td>`
    + `<td style="${TD}">${escape(dueText(inst))}</td><td style="${TD}${RIGHT}">${money(inst.value)}</td></tr>`);
  return `<table style="${TABLE}"><thead><tr><th style="${TH}">Parcela</th><th style="${TH}">Vencimento</th><th style="${TH}${RIGHT}">Valor</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

const termsBlock = (terms: TermText[]) => terms.map((term) => `<h3>${escape(term.title)}</h3>${term.body}`).join('') || '';

function signatureBlock(data: DocumentData): string {
  const cell = (name: string, sub: string) => `<td style="width:50%;padding:36px 12px 0;text-align:center;vertical-align:top"><div style="border-top:1px solid #333;padding-top:6px"><strong>${escape(name)}</strong><br><span style="font-size:0.9em">${escape(sub)}</span></div></td>`;
  return `<table style="width:100%;margin-top:24px"><tbody><tr>${cell(data.company.corporateName, `CNPJ ${cnpjBr(data.company.cnpj)}`)}${cell(data.customer.corporateName, `CNPJ ${cnpjBr(data.customer.cnpj)}`)}</tr></tbody></table>`;
}

/** Variáveis disponíveis nos modelos (a tela mostra esta lista). */
export const VARIABLES: Array<{ key: string; label: string; block?: boolean }> = [
  { key: 'cliente.nome', label: 'Nome do cliente' }, { key: 'cliente.razao_social', label: 'Razão social do cliente' }, { key: 'cliente.cnpj', label: 'CNPJ do cliente' },
  { key: 'contato.nome', label: 'Nome do contato' },
  { key: 'empresa.nome', label: 'Nome da sua empresa' }, { key: 'empresa.razao_social', label: 'Razão social da sua empresa' }, { key: 'empresa.cnpj', label: 'CNPJ da sua empresa' },
  { key: 'vendedor.nome', label: 'Vendedor' },
  { key: 'proposta.numero', label: 'Número da proposta' }, { key: 'proposta.titulo', label: 'Título' }, { key: 'proposta.descricao', label: 'Descrição' },
  { key: 'proposta.data', label: 'Data da proposta' }, { key: 'proposta.validade', label: 'Validade' },
  { key: 'prazo.dias', label: 'Prazo em dias úteis' }, { key: 'valor.total', label: 'Valor total' }, { key: 'valor.total_extenso', label: 'Valor total por extenso' },
  { key: 'cabecalho', label: 'Cabeçalho: logo, número e dados da empresa', block: true }, { key: 'cliente', label: 'Informações do cliente', block: true },
  { key: 'informacoes', label: 'Outras informações (emissão, validade, prazo, vendedor)', block: true },
  { key: 'cronograma', label: 'Cronograma em barras', block: true },
  { key: 'dados_bancarios', label: 'Dados bancários', block: true }, { key: 'rodape', label: 'Observação final (número e e-mail de tratativas)', block: true },
  { key: 'capa', label: 'Capa com logo e dados da proposta', block: true }, { key: 'resumo', label: 'Resumo em uma olhada', block: true },
  { key: 'imagens', label: 'Imagens da proposta (com marcações)', block: true }, { key: 'investimento', label: 'Destaque do investimento total', block: true },
  { key: 'sobre', label: 'Quem somos, números e diferenciais', block: true }, { key: 'depoimentos', label: 'Depoimentos de clientes', block: true },
  { key: 'proximos_passos', label: 'Próximos passos (como aceitar)', block: true }, { key: 'contato', label: 'Rodapé com o contato da empresa', block: true },
  { key: 'tabela_itens', label: 'Tabela de itens e valores', block: true }, { key: 'condicoes_pagamento', label: 'Condições de pagamento', block: true },
  { key: 'termos', label: 'Termos escolhidos', block: true }, { key: 'assinatura', label: 'Campo de assinatura', block: true },
];

/** Monta o documento: troca variáveis (com escape) e blocos no corpo já sanitizado. */
export function renderDocument(body: string, data: DocumentData, terms: TermText[], mode: ItemsMode): string {
  // o modelo de orçamento (o que tem o bloco de cabeçalho) usa tabelas e termos com a aparência dele
  const classic: Classic | null = data.brand && /\{\{\s*cabecalho\s*\}\}/.test(body) ? { color: data.brand.color, on: textOnColor(data.brand.color) } : null;
  const blocks: Record<string, string> = classic
    ? { tabela_itens: classicItemsTable(data, mode, classic), condicoes_pagamento: classicPaymentTable(data, classic), termos: classicTermsBlock(terms), assinatura: signatureBlock(data) }
    : { tabela_itens: itemsTable(data, mode), condicoes_pagamento: paymentTable(data), termos: termsBlock(terms), assinatura: signatureBlock(data) };
  const values: Record<string, string> = {
    'cliente.nome': data.customer.name, 'cliente.razao_social': data.customer.corporateName, 'cliente.cnpj': cnpjBr(data.customer.cnpj),
    'contato.nome': data.contactName ?? '', 'vendedor.nome': data.sellerName ?? '',
    'empresa.nome': data.company.name, 'empresa.razao_social': data.company.corporateName, 'empresa.cnpj': cnpjBr(data.company.cnpj),
    'proposta.numero': data.number, 'proposta.titulo': data.title, 'proposta.descricao': data.description ?? '',
    'proposta.data': dateBr(data.date), 'proposta.validade': data.validUntil ? dateBr(data.validUntil) : 'a combinar',
    'prazo.dias': String(data.workDays || ''), 'valor.total': money(data.total), 'valor.total_extenso': moneyInWords(data.total),
  };
  if (data.brand) {
    const blockData: BlockData = {
      brand: data.brand, company: data.company, contactName: data.contactName,
      customer: { ...data.customer, email: data.contactEmail || data.customer.email, phone: data.contactPhone || data.customer.phone },
      seller: data.seller ?? { name: data.sellerName, email: null, phone: null },
      number: data.number, title: data.title, date: data.date, validUntil: data.validUntil, workDays: data.workDays, total: data.total,
      totalInWords: moneyInWords(data.total), installments: data.installments, images: data.images ?? [], schedule: data.schedule, kind: data.kind,
    };
    for (const [key, build] of Object.entries(BRAND_BLOCKS)) blocks[key] = build(blockData);
  } else {
    // sem identidade carregada, os blocos novos somem em vez de aparecer como {{texto}}
    for (const key of Object.keys(BRAND_BLOCKS)) blocks[key] = '';
  }
  let html = sanitizeBody(body);
  // Bloco sozinho num parágrafo troca o parágrafo inteiro (tabela dentro de <p> é HTML inválido).
  for (const [key, block] of Object.entries(blocks)) {
    const alone = new RegExp(`<p[^>]*>(?:\\s|<[^>/]+>)*\\{\\{\\s*${key}\\s*\\}\\}(?:\\s|</[^>]+>)*</p>`, 'g');
    html = html.replace(alone, () => block).replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), () => block);
  }
  html = html.replace(/\{\{\s*([a-z_.]+)\s*\}\}/g, (match, key: string) => (key in values ? escape(values[key]).replace(/\n/g, '<br>') : match));
  if (data.brand) {
    // Seção que ficou vazia (identidade ainda não preenchida, proposta sem descrição ou sem imagens)
    // não deixa um título solto: some o parágrafo vazio e o título que não tem nada embaixo.
    html = html.replace(/<p>\s*<\/p>/g, '');
    let previous = '';
    while (previous !== html) {
      previous = html;
      // título (h2 ou h3) seguido direto de outro título, de um termo, da observação final ou do fim
      html = html.replace(/<h([23])[^>]*>(?:(?!<\/h\1>)[\s\S])*<\/h\1>(?=\s*(?:<h[23]|<div data-block="(?:termo|rodape)"|$))/g, '');
    }
  }
  // a cor da marca vai como variável: os títulos do texto usam a mesma cor da capa
  return data.brand ? `<div class="pd-root${classic ? ' pd-classic' : ''}" style="--brand:${data.brand.color}">${html}</div>` : html;
}

