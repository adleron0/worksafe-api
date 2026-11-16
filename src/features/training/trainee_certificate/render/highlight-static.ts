import {
  CertificateHighlightPattern,
  CertificateHighlightTheme,
} from '@prisma/client';
import { createCanvas } from 'canvas';
import { DEFAULT_FOIL_BORDER, FoilBorder, drawFoilBorder } from './highlight-border';

/**
 * Efeito de destaque ESTÁTICO (PNG, PDF, miniatura, prévia, impresso): a
 * versão em vetor do foil animado da página pública. Centro com a padronagem
 * escolhida, bem suave (multiplicado, para o texto continuar legível), e a
 * moldura com brilhos de formas e tamanhos sorteados. A sorte vem da chave do
 * certificado: o mesmo certificado sai sempre igual, e cada um é diferente.
 */

type Ctx = CanvasRenderingContext2D;

/** Degradê do brilho fixo (mesmas cores da etiqueta do tema no visualizador). */
const SHEEN: Record<CertificateHighlightTheme, string[]> = {
  ouro: ['#e8c770', '#f7e3a1', '#fff6d8', '#efd27e', '#d9b252'],
  prata: ['#c3ccd4', '#e3e8ec', '#ffffff', '#d5dce2', '#b5bfc8'],
  holografico: ['#ff9adf', '#a0e7ff', '#c8ffb0', '#ffe39a', '#d3a8ff'],
};

const PALETTE: Record<CertificateHighlightTheme, string[]> = {
  ouro: ['#e9c46a', '#d9a93c', '#f3dc8a', '#c99a2e', '#fff1c2'],
  prata: ['#c7d0da', '#aab6c3', '#dfe6ee', '#9aa5ae', '#f4f7fa'],
  holografico: [
    '#ff9ad8',
    '#8fd8ff',
    '#b6f5a0',
    '#ffe08a',
    '#c9a3ff',
    '#9df0e8',
  ],
};

/** Gerador determinístico (mulberry32) a partir de um texto. */
function rng(seedText: string) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function starPath(
  ctx: Ctx,
  x: number,
  y: number,
  r: number,
  points: number,
  inner: number,
  rot: number,
) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rr = i % 2 === 0 ? r : r * inner;
    const a = rot + (i * Math.PI) / points;
    if (i === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

/** Padronagem do centro, em vetor. */
function drawCenterPattern(
  ctx: Ctx,
  x0: number,
  y0: number,
  w: number,
  h: number,
  pattern: CertificateHighlightPattern,
  colors: string[],
  rand: () => number,
) {
  const unit = Math.min(w, h);
  const pick = () => colors[Math.floor(rand() * colors.length)];
  ctx.lineCap = 'round';

  if (pattern === 'rosetas') {
    // grade em 45° de rosetas de traços curtos (como o selo de segurança)
    const cell = unit * 0.3;
    const rings = [
      { r0: 0.33, r1: 0.47, n: 56 },
      { r0: 0.52, r1: 0.62, n: 56 },
      { r0: 0.7, r1: 0.85, n: 72 },
    ];
    for (let gy = -cell; gy < h + cell; gy += cell * 0.7071) {
      const row = Math.round(gy / (cell * 0.7071));
      for (let gx = (row % 2) * cell * 0.5 - cell; gx < w + cell; gx += cell) {
        const cx = x0 + gx;
        const cy = y0 + gy;
        ctx.strokeStyle = pick();
        ctx.lineWidth = unit * 0.0022;
        for (const ring of rings) {
          for (let k = 0; k < ring.n; k++) {
            if (k % 2 === 1 && ring.n === 72) continue;
            const a = (k / ring.n) * Math.PI * 2;
            const r0 = (cell / 2) * ring.r0;
            const r1 = (cell / 2) * ring.r1;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
            ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
            ctx.stroke();
          }
        }
      }
    }
  } else if (pattern === 'estrelas') {
    const n = Math.round(((w * h) / (unit * unit)) * 90);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = pick();
      const r = unit * (0.006 + Math.pow(rand(), 1.8) * 0.03);
      starPath(
        ctx,
        x0 + rand() * w,
        y0 + rand() * h,
        r,
        rand() < 0.4 ? 4 : 5,
        0.4,
        rand() * Math.PI,
      );
      ctx.fill();
    }
  } else if (pattern === 'estilhacos') {
    // mosaico de triângulos com pontos sorteados (facetas)
    const step = unit * 0.07;
    const pts: { x: number; y: number }[][] = [];
    for (let gy = 0; gy <= h / step + 1; gy++) {
      const row: { x: number; y: number }[] = [];
      for (let gx = 0; gx <= w / step + 1; gx++) {
        row.push({
          x: x0 + (gx + (rand() - 0.5) * 0.8) * step,
          y: y0 + (gy + (rand() - 0.5) * 0.8) * step,
        });
      }
      pts.push(row);
    }
    ctx.lineWidth = unit * 0.0012;
    for (let gy = 0; gy < pts.length - 1; gy++) {
      for (let gx = 0; gx < pts[gy].length - 1; gx++) {
        const a = pts[gy][gx],
          b = pts[gy][gx + 1],
          c = pts[gy + 1][gx],
          d = pts[gy + 1][gx + 1];
        for (const tri of [
          [a, b, d],
          [a, d, c],
        ]) {
          ctx.beginPath();
          ctx.moveTo(tri[0].x, tri[0].y);
          ctx.lineTo(tri[1].x, tri[1].y);
          ctx.lineTo(tri[2].x, tri[2].y);
          ctx.closePath();
          ctx.globalAlpha = 0.25 + rand() * 0.6;
          ctx.fillStyle = pick();
          ctx.fill();
          ctx.globalAlpha = 0.6;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
  } else if (pattern === 'bolhas') {
    const n = Math.round(((w * h) / (unit * unit)) * 40);
    for (let i = 0; i < n; i++) {
      ctx.strokeStyle = pick();
      ctx.lineWidth = unit * (0.0015 + rand() * 0.002);
      ctx.beginPath();
      ctx.arc(
        x0 + rand() * w,
        y0 + rand() * h,
        unit * (0.015 + rand() * 0.05),
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
  } else if (pattern === 'espiral') {
    const cx = x0 + w / 2;
    const cy = y0 + h * 0.42;
    const R = Math.hypot(w, h);
    const rays = 72;
    for (let k = 0; k < rays; k += 2) {
      const a0 = (k / rays) * Math.PI * 2;
      const a1 = ((k + 1) / rays) * Math.PI * 2;
      ctx.fillStyle = colors[(k / 2) % colors.length];
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a0, a1);
      ctx.closePath();
      ctx.fill();
    }
  } else if (pattern === 'arco_iris') {
    const g = ctx.createLinearGradient(x0, y0, x0 + w, y0 + h);
    const rainbow = [
      '#ff9ad8',
      '#ffe08a',
      '#b6f5a0',
      '#8fd8ff',
      '#c9a3ff',
      '#ff9ad8',
    ];
    for (let r = 0; r < 3; r++) {
      rainbow.forEach((c, i) =>
        g.addColorStop(Math.min(1, (r + i / (rainbow.length - 1)) / 3), c),
      );
    }
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, w, h);
  } else if (pattern === 'gravado') {
    ctx.strokeStyle = colors[0];
    ctx.lineWidth = unit * 0.0016;
    const gap = unit * 0.009;
    for (let d = -h; d < w + h; d += gap) {
      ctx.beginPath();
      ctx.moveTo(x0 + d, y0);
      ctx.lineTo(x0 + d - h * 0.6, y0 + h);
      ctx.stroke();
    }
  } else if (pattern === 'glitter') {
    const n = Math.round(((w * h) / (unit * unit)) * 900);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = pick();
      ctx.beginPath();
      ctx.arc(
        x0 + rand() * w,
        y0 + rand() * h,
        unit * (0.0012 + rand() * 0.0022),
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }
}

/**
 * Máscara esfumada: transparente até `zeroAt` da borda, opaca a partir de
 * `fullAt`, com transição suave entre os dois (faixas em degradê nos lados e
 * degradê radial nos cantos).
 */
function featherMask(w: number, h: number, zeroAt: number, fullAt: number) {
  const m = createCanvas(Math.round(w), Math.round(h));
  const c = m.getContext('2d') as unknown as Ctx;
  const f = fullAt - zeroAt;
  c.fillStyle = '#fff';
  c.fillRect(fullAt, fullAt, w - fullAt * 2, h - fullAt * 2);
  const side = (x0: number, y0: number, x1: number, y1: number, rx: number, ry: number, rw: number, rh: number) => {
    const g = c.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(255,255,255,1)');
    c.fillStyle = g;
    c.fillRect(rx, ry, rw, rh);
  };
  side(0, zeroAt, 0, fullAt, fullAt, zeroAt, w - fullAt * 2, f); // topo
  side(0, h - zeroAt, 0, h - fullAt, fullAt, h - fullAt, w - fullAt * 2, f); // base
  side(zeroAt, 0, fullAt, 0, zeroAt, fullAt, f, h - fullAt * 2); // esquerda
  side(w - zeroAt, 0, w - fullAt, 0, w - fullAt, fullAt, f, h - fullAt * 2); // direita
  for (const [cx, cy] of [
    [fullAt, fullAt],
    [w - fullAt, fullAt],
    [fullAt, h - fullAt],
    [w - fullAt, h - fullAt],
  ]) {
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, f);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(cx < w / 2 ? zeroAt : w - fullAt, cy < h / 2 ? zeroAt : h - fullAt, f, f);
  }
  return m;
}

/**
 * Desenha o efeito estático por cima do certificado já renderizado (px do
 * canvas). Chamar antes do selo.
 */
export function drawStaticFoil(
  ctx: Ctx,
  width: number,
  height: number,
  theme: CertificateHighlightTheme,
  pattern: CertificateHighlightPattern,
  seed: string,
  border: FoilBorder = DEFAULT_FOIL_BORDER,
) {
  const colors = PALETTE[theme] ?? PALETTE.ouro;
  const rand = rng(`${seed}|${theme}|${pattern}`);
  ctx.save();
  // A cor do tema e a padronagem do centro somem aos poucos perto da borda
  // (máscara esfumada): o papel fica tingido por igual, a corda fica limpa e
  // não sobra a linha reta onde o retângulo terminava.
  const unit = Math.min(width, height);
  const mask = featherMask(width, height, unit * 0.05, unit * 0.09);
  const overlay = (alpha: number, draw: (c: Ctx) => void) => {
    const layer = createCanvas(Math.round(width), Math.round(height));
    const lctx = layer.getContext('2d') as unknown as Ctx;
    draw(lctx);
    lctx.globalCompositeOperation = 'destination-in';
    lctx.drawImage(mask as unknown as CanvasImageSource, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = alpha;
    ctx.drawImage(layer as unknown as CanvasImageSource, 0, 0);
    ctx.restore();
  };
  // brilho fixo do tema (o que o visualizador mostra em movimento), para a
  // imagem/PDF baixados e a impressão também levarem a cor do foil
  overlay(0.28, (c) => {
    const stops = SHEEN[theme] ?? SHEEN.ouro;
    const g = c.createLinearGradient(0, 0, width, height);
    stops.forEach((col, i) => g.addColorStop(i / (stops.length - 1), col));
    c.fillStyle = g;
    c.fillRect(0, 0, width, height);
  });
  // centro: suave, multiplicado (tinge o papel e deixa o texto legível)
  if (pattern !== 'nenhum') {
    overlay(pattern === 'arco_iris' ? 0.22 : pattern === 'espiral' ? 0.12 : 0.3, (c) =>
      drawCenterPattern(c, 0, 0, width, height, pattern, colors, rand),
    );
  }
  // moldura: brilho no estilo escolhido, por cima, nítido
  drawFoilBorder(ctx, width, height, colors, () => rng(`${seed}|${theme}|borda`), border);
  ctx.restore();
}
