import { CertificateHighlightTheme } from '@prisma/client';
import { createCanvas } from 'canvas';

/**
 * Selo de destaque estático — o mosquetão do logo WorkSafe como placa: corpo
 * escuro, halo de listras diagonais e a trava na cor do tema (ouro, prata ou
 * furta-cor). Desenhado no canvas do render (node-canvas) para PNG, PDF,
 * miniatura e prévia de redes sociais. O texto usa as fontes já registradas
 * pelo fabric-setup (Bebas Neue e Montserrat).
 */

type Ctx = CanvasRenderingContext2D;

/** Traçados do logo (viewBox 30.87 × 43.8). */
export const LOGO_OUTER =
  'M26,5.82c-.08-.03-.16-.06-.24-.09-1.93-.68-3.83-1.46-5.77-2.13-2.4-.83-4.79-1.68-7.23-2.38C10.23.49,7.59-.26,4.94.09,1.84.51,0,3.68,0,6.75v31.64c0,.54.07,1.08.21,1.6.14.49.34.95.62,1.37.27.41.59.78.97,1.09,1.08.88,2.5,1.15,3.86,1.27.98.09,1.96.09,2.95.05.34-.01.68-.03,1.03-.04.37-.02.75-.04,1.12-.07.4-.03.8-.06,1.19-.1.42-.04.84-.08,1.25-.13.43-.05.86-.1,1.29-.16.44-.06.88-.12,1.32-.2.44-.07.89-.15,1.33-.23s.88-.17,1.32-.27c.43-.1.87-.2,1.3-.32.42-.11.84-.23,1.26-.36.4-.13.81-.26,1.2-.41.38-.14.76-.29,1.13-.46.35-.16.7-.33,1.04-.51.32-.17.63-.36.94-.56.28-.19.56-.4.81-.62.24-.21.47-.44.68-.68.2-.23.37-.48.52-.74.23-.41.39-.86.47-1.32.03-.19.05-.39.08-.58.03-.2.05-.4.08-.6.03-.27.07-.53.1-.8.04-.33.08-.65.12-.98.05-.38.1-.76.14-1.13.05-.42.11-.85.16-1.27.06-.46.12-.93.18-1.39.06-.5.13-.99.19-1.49.07-.52.13-1.05.2-1.57.07-.54.14-1.09.21-1.63.07-.56.14-1.11.21-1.67.07-.56.14-1.13.21-1.69.07-.56.14-1.13.21-1.69.07-.56.14-1.12.21-1.67.07-.55.14-1.09.21-1.64.19-1.54.43-3.07.54-4.61.09-1.33-.09-2.67-.86-3.8-.92-1.35-2.5-2.04-3.99-2.57';
/** Abertura interna do mosquetão (recorte, regra evenodd). */
export const LOGO_INNER =
  'M16.53,30.46c-.05.1-.1.2-.14.3v.03c-1.02,2.09-1.57,2.7-3.57,2.7,0,0-2.2,0-2.64-1.91l-.82-15.66s0-.04,0-.06c-.08-1.83,1.16-3.97,2.99-3.91.8.03,1.57.34,2.31.64,1.26.5,2.54.97,3.82,1.43,1.37.49,2.94.9,3.21,2.55.22,1.34-.42,2.55-.92,3.74-.54,1.29-1.09,2.58-1.63,3.87l-2.16,5.16c-.15.37-.3.74-.46,1.1h0Z';
export const LOGO_GATE =
  'M30.16,18.02l-2.23,17.67-12.34-3.46s2.58-5.72,3.41-7.67c.68-1.6,2.65-6.54,2.65-6.54h8.52';
const LOGO_W = 30.87;
const LOGO_H = 43.8;
/** Margem em volta do logo para o halo (unidades do logo). */
const PAD = 3;
const VIEW_W = LOGO_W + PAD * 2;
const VIEW_H = LOGO_H + PAD * 2;

const DARK = '#26282b';
const PAPER = '#f7f3ee';

const METAL: Record<CertificateHighlightTheme, string[]> = {
  ouro: ['#8a5a12', '#d4a640', '#f7e3a3', '#c9952e', '#7d520f'],
  prata: ['#5c666e', '#aab4bc', '#f4f7f9', '#9ea9b2', '#56616a'],
  holografico: ['#f08ad0', '#8fc9ff', '#b9f5a8', '#ffe08a', '#c29cff'],
};

export interface SealBox {
  /** Canto superior esquerdo e lado do quadrado reservado ao selo, em px do canvas. */
  x: number;
  y: number;
  size: number;
}

/** Altura total ocupada (selo + legenda), em múltiplos do lado. */
export const SEAL_HEIGHT_RATIO = 1.12;

/**
 * Traça um caminho SVG (M, L, H, V, C, S, Z — absolutos e relativos) no
 * contexto. O node-canvas não tem Path2D; o logo só usa esses comandos.
 */
export function tracePath(ctx: Ctx, d: string, begin = true) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+\.?)(?:e-?\d+)?/g) ?? [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let c2x = 0;
  let c2y = 0;
  let prev = '';
  const num = () => parseFloat(tokens[i++]);
  if (begin) ctx.beginPath();
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'Z') {
      ctx.closePath();
      x = sx;
      y = sy;
      prev = 'Z';
      continue;
    }
    if (C === 'M' || C === 'L') {
      const nx = num() + (rel ? x : 0);
      const ny = num() + (rel ? y : 0);
      if (C === 'M') {
        ctx.moveTo(nx, ny);
        sx = nx;
        sy = ny;
        cmd = rel ? 'l' : 'L'; // pares seguintes são linhas
      } else ctx.lineTo(nx, ny);
      x = nx;
      y = ny;
    } else if (C === 'H') {
      x = num() + (rel ? x : 0);
      ctx.lineTo(x, y);
    } else if (C === 'V') {
      y = num() + (rel ? y : 0);
      ctx.lineTo(x, y);
    } else if (C === 'C' || C === 'S') {
      let x1: number;
      let y1: number;
      if (C === 'C') {
        x1 = num() + (rel ? x : 0);
        y1 = num() + (rel ? y : 0);
      } else {
        const smooth = prev === 'C' || prev === 'S';
        x1 = smooth ? 2 * x - c2x : x;
        y1 = smooth ? 2 * y - c2y : y;
      }
      const x2 = num() + (rel ? x : 0);
      const y2 = num() + (rel ? y : 0);
      const ex = num() + (rel ? x : 0);
      const ey = num() + (rel ? y : 0);
      ctx.bezierCurveTo(x1, y1, x2, y2, ex, ey);
      c2x = x2;
      c2y = y2;
      x = ex;
      y = ey;
    } else {
      i++; // comando não usado pelo logo
    }
    prev = C;
  }
}

const metalGradient = (
  ctx: Ctx,
  theme: CertificateHighlightTheme,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) => {
  const stops = METAL[theme] ?? METAL.ouro;
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  return g;
};

/** Maior tamanho (até `max`) em que o texto cabe em `width`. */
const fitFont = (
  ctx: Ctx,
  text: string,
  width: number,
  max: number,
  font: (px: number) => string,
) => {
  let px = max;
  ctx.font = font(px);
  while (px > 0.5 && ctx.measureText(text).width > width) {
    px *= 0.95;
    ctx.font = font(px);
  }
  return px;
};

/** Texto com espaçamento entre letras (letterSpacing não é confiável no node-canvas). */
const spacedText = (
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  spacing: number,
  align: 'left' | 'center' | 'right',
) => {
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1);
  let cx =
    align === 'left' ? x : align === 'center' ? x - total / 2 : x - total;
  ctx.textAlign = 'left';
  [...text].forEach((ch, k) => {
    ctx.fillText(ch, cx, y);
    cx += widths[k] + spacing;
  });
};

/** Divide o texto da faixa em duas linhas equilibradas. */
const splitLabel = (label: string): [string, string] => {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length < 2) return [label, ''];
  let best: [string, string] = [label, ''];
  let diff = Infinity;
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(' ');
    const b = words.slice(k).join(' ');
    const d = Math.abs(a.length - b.length);
    if (d < diff) {
      diff = d;
      best = [a, b];
    }
  }
  return best;
};

/**
 * Desenha o selo. `box` é o quadrado reservado (marcador do editor ou canto
 * padrão); o selo ocupa a altura do quadrado, centralizado na largura, e a
 * legenda opcional fica logo abaixo.
 */
export function drawHighlightSeal(
  ctx: Ctx,
  box: SealBox,
  theme: CertificateHighlightTheme,
  label: string,
  caption?: string | null,
  year?: string | number | null,
) {
  const unit = box.size / VIEW_H; // px por unidade do logo
  const sealW = VIEW_W * unit;
  const ox = box.x + (box.size - sealW) / 2 + PAD * unit;
  const oy = box.y + PAD * unit;

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(unit, unit);

  // halo: contorno grosso listrado, numa camada à parte (listras recortadas
  // pelo traço) para a largura ser uniforme em volta do mosquetão
  {
    const scale = unit;
    const w = Math.ceil(VIEW_W * scale);
    const h = Math.ceil(VIEW_H * scale);
    const layer = createCanvas(w, h);
    const l = layer.getContext('2d') as unknown as Ctx;
    l.translate(PAD * scale, PAD * scale);
    l.scale(scale, scale);
    tracePath(l, LOGO_OUTER);
    l.lineWidth = 3.6;
    l.lineJoin = 'round';
    l.strokeStyle = '#000';
    l.stroke();
    // listras só onde há traço
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.globalCompositeOperation = 'source-in';
    l.translate(w / 2, h / 2);
    l.rotate((-40 * Math.PI) / 180);
    const gap = 1.25 * scale; // passo das listras
    const R = Math.hypot(w, h);
    l.fillStyle = '#2b2d31';
    // um preenchimento só: com source-in, cada fill apagaria os anteriores
    l.beginPath();
    for (let v = -R; v < R; v += gap) l.rect(-R, v, R * 2, gap * 0.44);
    l.fill();
    ctx.drawImage(layer as any, -PAD, -PAD, VIEW_W, VIEW_H);
  }

  // corpo e trava
  tracePath(ctx, LOGO_OUTER);
  ctx.fillStyle = DARK;
  ctx.fill();
  // trava menor que no logo, ancorada na borda direita, para dar respiro aos textos
  {
    const k = 0.78;
    const ax = 30.2, ay = 26.8;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.scale(k, k);
    ctx.translate(-ax, -ay);
    tracePath(ctx, LOGO_GATE);
    ctx.fillStyle = metalGradient(ctx, theme, 15.5, 18, 30.2, 35.7);
    ctx.fill();
    ctx.restore();
  }

  // textos
  ctx.textBaseline = 'alphabetic';
  const bebas = (px: number) => `${px}px "Bebas Neue"`;
  const yearText = String(year ?? new Date().getFullYear());
  ctx.font = bebas(8.2);
  ctx.fillStyle = PAPER;
  // todos os textos alinhados à esquerda, na mesma margem de ALUNO DESTAQUE
  const LEFT = 2.6;
  ctx.textAlign = 'left';
  ctx.fillText(yearText, LEFT, 13.6);

  const [l1, l2] = splitLabel(label.toUpperCase());
  // mesmo tamanho nas duas linhas: o da que precisar encolher mais
  const size = Math.min(
    fitFont(ctx, l1, 13.5, 5.2, bebas),
    l2 ? fitFont(ctx, l2, 13.5, 5.2, bebas) : 5.2,
  );
  ctx.font = bebas(size);
  ctx.fillStyle = metalGradient(ctx, theme, 2.6, 18, 16, 25);
  spacedText(ctx, l1, LEFT, l2 ? 24 : 27, 0.1, 'left');
  if (l2) {
    ctx.fillStyle = PAPER;
    spacedText(ctx, l2, LEFT, 24 + size * 1.08, 0.1, 'left');
  }

  ctx.fillStyle = 'rgba(247,243,238,0.85)';
  ctx.font = '700 1.7px "Montserrat"';
  spacedText(ctx, 'WORKSAFE', LEFT, 36.2, 0.22, 'left');
  spacedText(ctx, 'BRASIL', LEFT, 38.4, 0.22, 'left');

  ctx.restore();

  // legenda pequena (ex.: convite a verificar o selo digital pelo QR)
  if (caption) {
    ctx.save();
    const capY = box.y + box.size + box.size * 0.06;
    const px = fitFont(
      ctx,
      caption,
      box.size * 1.25,
      box.size * 0.07,
      (p) => `400 ${p}px "Montserrat"`,
    );
    ctx.font = `400 ${px}px "Montserrat"`;
    ctx.fillStyle = 'rgba(60,60,60,0.85)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(caption, box.x + box.size / 2, capY);
    ctx.restore();
  }
}
