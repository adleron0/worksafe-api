/**
 * Blocos de identidade da proposta: capa, resumo, investimento, quem somos,
 * depoimentos, imagens com marcações, próximos passos e contato.
 *
 * Funções puras. Tudo sai com estilo embutido (a proposta precisa ficar igual
 * na tela, no celular e na impressão) e todo texto passa por escape.
 */

export interface Brand {
  logoUrl: string | null;
  /** cor de destaque, em #RRGGBB */
  color: string;
  tagline: string;
  about: string;
  /** números de impacto: "+500" / "profissionais treinados" */
  highlights: Array<{ value: string; label: string }>;
  differentials: Array<{ title: string; text: string }>;
  testimonials: Array<{ quote: string; author: string; company: string }>;
  phone: string; email: string; website: string; address: string;
  /** linhas extras do cabeçalho (inscrição estadual, municipal...) */
  registrations?: string;
  /** dados para pagamento: banco, agência, conta, chave PIX */
  payment?: string;
}

export type Annotation =
  | { type: 'circulo'; x: number; y: number; w: number; h: number; label: string }
  | { type: 'seta'; x1: number; y1: number; x2: number; y2: number; label: string };

export interface ProposalImage { url: string; title: string; description: string; annotations: Annotation[] }

/** Cronograma simples: etapas com início e duração, na unidade escolhida. */
export interface ScheduleStep { title: string; start: number; duration: number }
export interface Schedule { unit: 'dia' | 'semana' | 'mes'; steps: ScheduleStep[] }

export interface BlockData {
  brand: Brand;
  company: { name: string; corporateName?: string; cnpj?: string; addressLines?: string[] };
  customer: { name: string; corporateName: string; cnpj?: string; email?: string; phone?: string; addressLines?: string[] };
  contactName: string | null;
  seller: { name: string | null; email: string | null; phone: string | null };
  number: string; title: string; date: Date; validUntil: string | null; workDays: number; total: number;
  totalInWords: string;
  installments: Array<{ value: number }>;
  images: ProposalImage[];
  schedule?: Schedule;
}

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const lines = (value: string) => esc(value).replace(/\n/g, '<br>');
const money = (value: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
const dateBr = (value: Date | string | null | undefined) => {
  if (!value) return '';
  const iso = typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
  return iso.split('-').reverse().join('/');
};
const dateLong = (value: Date) => new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(value);

export const DEFAULT_COLOR = '#16A34A';
/** Texto que lê melhor sobre a cor da marca (para o cabeçalho das tabelas). */
export const textOnColor = (color: string) => textOn(color);
export const validColor = (value: unknown) => (/^#[0-9a-f]{6}$/i.test(String(value ?? '')) ? String(value).toUpperCase() : DEFAULT_COLOR);
/** Só imagem por https entra no documento. */
export const safeImageUrl = (value: unknown): string | null => {
  const url = String(value ?? '').trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(url) && url.length <= 600 ? url : null;
};

/** Texto branco ou escuro, o que ler melhor sobre a cor da marca. */
function textOn(color: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#111111' : '#FFFFFF';
}
/** Fundo bem claro da cor da marca (para cartões). */
const tint = (color: string, alpha: string) => `${color}${alpha}`;
// o navegador não imprime fundo por padrão: sem isto a capa sairia em branco no PDF
const PRINT = '-webkit-print-color-adjust:exact;print-color-adjust:exact';

export function coverBlock(d: BlockData): string {
  const color = d.brand.color, on = textOn(color);
  const meta = [
    ['Proposta', d.number], ['Data', dateLong(d.date)], ['Válida até', d.validUntil ? dateBr(d.validUntil) : 'a combinar'],
    ...(d.seller.name ? [['Responsável', d.seller.name]] : []),
  ];
  const logo = d.brand.logoUrl
    ? `<div style="display:inline-block;background:#FFFFFF;border-radius:10px;padding:10px 14px;margin-bottom:28px;${PRINT}"><img src="${esc(d.brand.logoUrl)}" alt="${esc(d.company.name)}" style="display:block;height:44px;width:auto;max-width:220px"></div>`
    : `<div style="font-size:20px;font-weight:800;letter-spacing:.02em;margin-bottom:28px">${esc(d.company.name)}</div>`;
  return `<div data-block="capa" style="background:${color};color:${on};border-radius:14px;padding:36px 32px 28px;margin:0 0 28px;${PRINT}">`
    + logo
    + `<div style="font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;opacity:.85">Proposta comercial</div>`
    + `<div style="font-size:30px;font-weight:800;line-height:1.15;margin:8px 0 14px">${esc(d.title)}</div>`
    + `<div style="font-size:16px;line-height:1.4">Preparada para <strong>${esc(d.customer.corporateName || d.customer.name)}</strong>${d.contactName ? `<br><span style="opacity:.9">A/C ${esc(d.contactName)}</span>` : ''}</div>`
    + (d.brand.tagline ? `<div style="font-size:14px;opacity:.9;margin-top:14px">${esc(d.brand.tagline)}</div>` : '')
    + `<div style="display:flex;flex-wrap:wrap;gap:8px 28px;margin-top:26px;padding-top:18px;border-top:1px solid ${on === '#FFFFFF' ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.25)'}">`
    + meta.map(([label, value]) => `<div><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.8">${esc(label)}</div><div style="font-size:14px;font-weight:700">${esc(value)}</div></div>`).join('')
    + `</div></div>`;
}

const card = (color: string, inner: string) =>
  `<div style="border:1px solid ${tint(color, '55')};background:${tint(color, '0F')};border-radius:12px;padding:18px 20px;margin:10px 0 18px;${PRINT}">${inner}</div>`;

function paymentSummary(d: BlockData): string {
  const n = d.installments.length;
  if (!n) return 'Condições de pagamento a combinar';
  if (n === 1) return 'Pagamento único';
  const equal = d.installments.every((inst) => Math.abs(inst.value - d.installments[0].value) < 0.02);
  return equal ? `${n} parcelas de ${money(d.installments[0].value)}` : `${n} parcelas`;
}

/** Resumo de uma olhada: o que, para quem, prazo, investimento e validade. */
export function summaryBlock(d: BlockData): string {
  const color = d.brand.color;
  const item = (label: string, value: string) => `<div style="flex:1 1 150px;min-width:0"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#555">${esc(label)}</div><div style="font-size:15px;font-weight:700;color:#111">${value}</div></div>`;
  return `<div data-block="resumo">${card(color, `<div style="display:flex;flex-wrap:wrap;gap:16px 24px">`
    + item('O que', esc(d.title))
    + (d.workDays ? item('Prazo de execução', `${d.workDays} dia${d.workDays === 1 ? '' : 's'} útei${d.workDays === 1 ? 'l' : 's'}`) : '')
    + item('Investimento', money(d.total))
    + item('Pagamento', esc(paymentSummary(d)))
    + item('Proposta válida até', esc(d.validUntil ? dateBr(d.validUntil) : 'a combinar'))
    + `</div>`)}</div>`;
}

export function investmentBlock(d: BlockData): string {
  const color = d.brand.color;
  return `<div data-block="investimento" style="border:2px solid ${color};border-radius:12px;padding:20px 22px;margin:10px 0 18px;text-align:center;${PRINT}">`
    + `<div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#555">Investimento total</div>`
    + `<div style="font-size:34px;font-weight:800;color:${color};line-height:1.2;margin:4px 0">${money(d.total)}</div>`
    + `<div style="font-size:13px;color:#555">${esc(d.totalInWords)}</div>`
    + `<div style="font-size:14px;color:#111;margin-top:8px"><strong>${esc(paymentSummary(d))}</strong></div>`
    + `</div>`;
}

export function aboutBlock(d: BlockData): string {
  const { brand } = d;
  const parts: string[] = [];
  if (brand.about) parts.push(`<p style="margin:0 0 14px">${lines(brand.about)}</p>`);
  if (brand.highlights.length) {
    parts.push(`<div style="display:flex;flex-wrap:wrap;gap:12px;margin:0 0 16px">`
      + brand.highlights.map((h) => `<div style="flex:1 1 130px;text-align:center;border-radius:10px;background:${tint(brand.color, '14')};padding:14px 10px;${PRINT}">`
        + `<div style="font-size:24px;font-weight:800;color:${brand.color};line-height:1.1">${esc(h.value)}</div><div style="font-size:12px;color:#444;margin-top:4px">${esc(h.label)}</div></div>`).join('')
      + `</div>`);
  }
  if (brand.differentials.length) {
    parts.push(`<div style="display:flex;flex-wrap:wrap;gap:12px">`
      + brand.differentials.map((item) => `<div style="flex:1 1 220px;border-left:4px solid ${brand.color};padding:2px 0 2px 12px">`
        + `<div style="font-weight:700;color:#111">${esc(item.title)}</div>${item.text ? `<div style="font-size:14px;color:#444">${lines(item.text)}</div>` : ''}</div>`).join('')
      + `</div>`);
  }
  return parts.length ? `<div data-block="sobre" style="margin:8px 0 18px">${parts.join('')}</div>` : '';
}

export function testimonialsBlock(d: BlockData): string {
  const list = d.brand.testimonials.filter((t) => t.quote);
  if (!list.length) return '';
  return `<div data-block="depoimentos" style="display:flex;flex-wrap:wrap;gap:12px;margin:8px 0 18px">`
    + list.map((t) => `<div style="flex:1 1 240px;border-radius:10px;background:#F6F6F6;padding:14px 16px;${PRINT}">`
      + `<div style="font-size:14px;color:#222;font-style:italic">“${lines(t.quote)}”</div>`
      + `<div style="font-size:13px;color:#555;margin-top:8px"><strong>${esc(t.author)}</strong>${t.company ? ` · ${esc(t.company)}` : ''}</div></div>`).join('')
    + `</div>`;
}

const clamp = (value: unknown) => Math.min(100, Math.max(0, Number(value) || 0));
const MARK = '#E11D48';
const badge = (n: number, left: number, top: number) =>
  `<div style="position:absolute;left:${left}%;top:${top}%;transform:translate(-50%,-50%);width:26px;height:26px;border-radius:50%;background:${MARK};color:#FFF;border:2px solid #FFF;`
  + `font:700 13px/22px system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.4);${PRINT}">${n}</div>`;

/** Imagem com as marcações por cima (círculos e setas numerados) e a legenda embaixo. */
export function imageFigure(image: ProposalImage, alt = ''): string {
  const shapes: string[] = [], badges: string[] = [], legend: string[] = [];
  image.annotations.forEach((mark, index) => {
    const n = index + 1;
    if (mark.type === 'circulo') {
      const x = clamp(mark.x), y = clamp(mark.y), w = clamp(mark.w), h = clamp(mark.h);
      const ellipse = (stroke: string, width: number) => `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="none" stroke="${stroke}" stroke-width="${width}" vector-effect="non-scaling-stroke"/>`;
      shapes.push(ellipse('#FFFFFF', 6), ellipse(MARK, 3));
      badges.push(badge(n, x + w / 2, y));
    } else {
      const x1 = clamp(mark.x1), y1 = clamp(mark.y1), x2 = clamp(mark.x2), y2 = clamp(mark.y2);
      const line = (stroke: string, width: number) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
      shapes.push(line('#FFFFFF', 6), line(MARK, 3));
      badges.push(badge(n, x1, y1));
      // ponta: um ponto no detalhe apontado (seta em SVG esticado ficaria torta)
      badges.push(`<div style="position:absolute;left:${x2}%;top:${y2}%;transform:translate(-50%,-50%);width:14px;height:14px;border-radius:50%;background:${MARK};border:2px solid #FFF;box-shadow:0 1px 3px rgba(0,0,0,.4);${PRINT}"></div>`);
    }
    if (mark.label) legend.push(`<li style="margin:2px 0"><strong style="color:${MARK}">${n}</strong> — ${esc(mark.label)}</li>`);
  });
  return `<figure data-block="imagem" style="margin:0;break-inside:avoid;page-break-inside:avoid">`
    + `<div style="position:relative;line-height:0;border-radius:10px;overflow:hidden;border:1px solid #DDD">`
    + `<img src="${esc(image.url)}" alt="${esc(image.title || alt)}" style="display:block;width:100%;height:auto">`
    + (shapes.length ? `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;left:0;top:0;width:100%;height:100%" aria-hidden="true">${shapes.join('')}</svg>` : '')
    + badges.join('')
    + `</div>`
    + ((image.title || image.description || legend.length) ? `<figcaption style="font-size:14px;color:#333;margin-top:8px;line-height:1.45">`
      + (image.title ? `<strong style="color:#111">${esc(image.title)}</strong>` : '')
      + (image.description ? `<div>${lines(image.description)}</div>` : '')
      + (legend.length ? `<ul style="list-style:none;margin:6px 0 0;padding:0">${legend.join('')}</ul>` : '')
      + `</figcaption>` : '')
    + `</figure>`;
}

export function imagesBlock(d: BlockData): string {
  if (!d.images.length) return '';
  // uma imagem sozinha fica centralizada, sem ocupar a tela inteira; várias ficam lado a lado e quebram no celular
  const single = d.images.length === 1;
  return `<div data-block="imagens" style="display:flex;flex-wrap:wrap;justify-content:center;gap:18px;margin:10px 0 20px">`
    + d.images.map((image) => `<div style="flex:${single ? '0 1 620px' : '1 1 300px'};max-width:${single ? '620px' : '100%'};min-width:0">${imageFigure(image, d.title)}</div>`).join('')
    + `</div>`;
}

export function nextStepsBlock(d: BlockData): string {
  const color = d.brand.color, on = textOn(color);
  const steps: Array<[string, string]> = [
    ['Leia a proposta', 'Confira o escopo, os valores e as condições. Qualquer dúvida, fale com a gente antes de aceitar.'],
    ['Aceite por aqui mesmo', 'No final desta página, clique em “Aceitar a proposta” e informe seus dados. Leva um minuto e vale como aceite formal.'],
    ['Combinamos o início', `Assim que recebermos o aceite, ${esc(d.company.name)} entra em contato para agendar e alinhar os detalhes.`],
  ];
  const contact = [d.seller.name, d.seller.phone, d.seller.email].filter(Boolean).map(esc).join(' · ');
  return `<div data-block="proximos_passos" style="margin:10px 0 18px">`
    + steps.map(([title, text], index) => `<div style="display:flex;gap:14px;align-items:flex-start;margin:0 0 12px">`
      + `<div style="flex:0 0 34px;height:34px;border-radius:50%;background:${color};color:${on};font:800 16px/34px system-ui,sans-serif;text-align:center;${PRINT}">${index + 1}</div>`
      + `<div style="min-width:0"><div style="font-weight:700;color:#111">${title}</div><div style="font-size:14px;color:#444">${text}</div></div></div>`).join('')
    + (d.validUntil ? `<div style="font-size:14px;color:#111;margin-top:6px">Os valores e as condições desta proposta valem até <strong>${dateBr(d.validUntil)}</strong>.</div>` : '')
    + (contact ? `<div style="font-size:14px;color:#444;margin-top:4px">Dúvidas? ${contact}</div>` : '')
    + `</div>`;
}

export function contactBlock(d: BlockData): string {
  const { brand } = d;
  const parts = [brand.phone, brand.email, brand.website.replace(/^https?:\/\//, ''), brand.address].filter(Boolean).map(esc);
  if (!parts.length) return '';
  return `<div data-block="contato" style="border-top:3px solid ${brand.color};margin-top:28px;padding-top:12px;font-size:13px;color:#555;text-align:center">`
    + `<strong style="color:#111">${esc(d.company.name)}</strong><br>${parts.join(' · ')}</div>`;
}

// ---------------------------------------------------------------- modelo de orçamento
// Blocos sóbrios, na ordem do orçamento que a empresa sempre usou: cabeçalho com
// os dados da empresa, cliente, outras informações, dados bancários e rodapé.

const cnpjBr = (cnpj?: string) => (cnpj?.length === 14 ? cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : cnpj ?? '');
const HEADING = 'font-size:1.25em;font-weight:400;letter-spacing:.02em;color:#111;margin:0 0 10px';
const SMALL = 'font-size:.9em;color:#222;line-height:1.5';

export function headerBlock(d: BlockData): string {
  const { brand, company } = d;
  const logo = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="${esc(company.name)}" style="display:block;height:34px;width:auto;max-width:160px">`
    : `<div style="font-size:1.2em;font-weight:800">${esc(company.name)}</div>`;
  const right = [
    company.cnpj ? `CNPJ: ${esc(cnpjBr(company.cnpj))}` : '',
    ...(brand.registrations ?? '').split('\n').map((line) => esc(line.trim())),
    ...(company.addressLines?.length ? company.addressLines.map(esc) : [esc(brand.address)]),
    brand.phone ? `Telefone: ${esc(brand.phone)}` : '',
  ].filter(Boolean);
  // compacto: logo pequena e número à esquerda, dados da empresa em letra miúda à direita, um traço embaixo
  return `<div data-block="cabecalho" style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:8px 24px;margin:0 0 14px;padding-bottom:10px;border-bottom:1px solid #999">`
    + `<div style="min-width:0">${logo}<div style="font-size:1.2em;font-weight:600;color:#111;margin-top:8px;line-height:1.2">PROPOSTA Nº ${esc(d.number)}</div></div>`
    + `<div style="min-width:0;margin-left:auto;text-align:right;font-size:.78em;color:#333;line-height:1.35"><div style="font-size:1.15em;font-weight:600;color:#111">${esc((company.corporateName || company.name).toUpperCase())}</div>${right.join('<br>')}</div>`
    + `</div>`;
}

export function customerBlock(d: BlockData): string {
  const { customer } = d;
  const left = [customer.cnpj ? `CNPJ: ${esc(cnpjBr(customer.cnpj))}` : '', esc(customer.email ?? ''), d.contactName ? `A/C ${esc(d.contactName)}` : ''].filter(Boolean);
  const right = [...(customer.addressLines ?? []).map(esc), customer.phone ? `Telefone: ${esc(customer.phone)}` : ''].filter(Boolean);
  return `<div data-block="cliente" style="margin:0 0 22px"><div style="${HEADING}">Informações do cliente</div>`
    + `<div style="font-size:1.05em;color:#111;margin-bottom:8px">${esc((customer.corporateName || customer.name).toUpperCase())}</div>`
    + `<div style="display:flex;flex-wrap:wrap;gap:6px 40px;${SMALL}"><div style="flex:1 1 220px;min-width:0">${left.join('<br>')}</div>${right.length ? `<div style="flex:1 1 260px;min-width:0">${right.join('<br>')}</div>` : ''}</div>`
    + `</div>`;
}

export function infoBlock(d: BlockData): string {
  const rows: Array<[string, string]> = [
    ['Proposta emitida em', dateBr(d.date)],
    ['Validade da proposta', d.validUntil ? `até ${dateBr(d.validUntil)}` : 'a combinar'],
    ...(d.workDays ? [['Prazo de execução', `${d.workDays} dia${d.workDays === 1 ? '' : 's'} útei${d.workDays === 1 ? 'l' : 's'}`] as [string, string]] : []),
    ...(d.seller.name ? [['Vendedor', d.seller.name.toUpperCase()] as [string, string]] : []),
  ];
  return `<div data-block="informacoes" style="${SMALL};margin:0 0 14px">${rows.map(([label, value]) => `${esc(label)}: <span style="color:#111">${esc(value)}</span>`).join('<br>')}</div>`;
}

const SUBTITLE = 'font-size:.85em;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#111;margin:0 0 6px';

export function bankBlock(d: BlockData): string {
  const payment = (d.brand.payment ?? '').trim();
  if (!payment) return '';
  return `<div data-block="dados_bancarios" style="${SMALL};margin:14px 0"><div style="${SUBTITLE}">Dados bancários</div>${lines(payment)}</div>`;
}

const UNIT: Record<Schedule['unit'], { short: string; one: string; many: string }> = {
  dia: { short: 'D', one: 'dia', many: 'dias' }, semana: { short: 'S', one: 'semana', many: 'semanas' }, mes: { short: 'M', one: 'mês', many: 'meses' },
};

/** Cronograma em barras: uma linha por etapa, com a escala em cima quando ela cabe. */
export function scheduleBlock(d: BlockData): string {
  const steps = d.schedule?.steps ?? [];
  if (!steps.length) return '';
  const unit = UNIT[d.schedule!.unit] ?? UNIT.dia;
  const total = Math.max(...steps.map((step) => step.start + step.duration - 1));
  const color = d.brand.color;
  const LABEL = 'flex:0 0 38%;min-width:0;padding:5px 8px 5px 0';
  const scale = total <= 18
    ? `<div style="display:flex;align-items:center"><div style="${LABEL};font-size:.85em;color:#555">Etapa</div><div style="flex:1;display:flex">`
      + Array.from({ length: total }, (_, i) => `<div style="flex:1;text-align:center;font-size:.72em;color:#555;border-left:1px solid #E5E5E5">${unit.short}${i + 1}</div>`).join('')
      + `</div></div>`
    : '';
  const rows = steps.map((step) => {
    const end = step.start + step.duration - 1;
    const period = step.duration === 1 ? `${unit.one} ${step.start}` : `${unit.many} ${step.start} a ${end}`;
    return `<div style="display:flex;align-items:center;border-top:1px solid #E5E5E5">`
      + `<div style="${LABEL}">${esc(step.title)}<br><span style="font-size:.85em;color:#555">${period}</span></div>`
      + `<div style="flex:1;min-width:0"><div style="margin-left:${((step.start - 1) / total) * 100}%;width:${(step.duration / total) * 100}%;height:14px;border-radius:3px;background:${color};${PRINT}"></div></div>`
      + `</div>`;
  }).join('');
  return `<div data-block="cronograma" style="font-size:.9em;line-height:1.35;margin:4px 0 10px;break-inside:avoid;page-break-inside:avoid">${scale}${rows}`
    + `<div style="border-top:1px solid #E5E5E5;padding-top:5px;font-size:.85em;color:#555">Duração total estimada: ${total} ${total === 1 ? unit.one : unit.many}, contados do início das atividades.</div></div>`;
}

export function footerNoteBlock(d: BlockData): string {
  const notes = [
    `Ao responder esta proposta por e-mail, mencione o número ${esc(d.number)} para nossa referência.`,
    d.brand.email ? `Tratativas sobre esta proposta sempre pelo e-mail ${esc(d.brand.email)}.` : '',
  ].filter(Boolean);
  return `<div data-block="rodape" style="border-top:1px solid #999;margin-top:22px;padding-top:10px;${SMALL}">${notes.join('<br>')}</div>`;
}

export const BRAND_BLOCKS: Record<string, (d: BlockData) => string> = {
  cronograma: scheduleBlock,
  cabecalho: headerBlock, cliente: customerBlock, informacoes: infoBlock, dados_bancarios: bankBlock, rodape: footerNoteBlock,
  capa: coverBlock, resumo: summaryBlock, investimento: investmentBlock, sobre: aboutBlock, depoimentos: testimonialsBlock,
  imagens: imagesBlock, proximos_passos: nextStepsBlock, contato: contactBlock,
};
