import {
  CertificateHighlightPattern,
  CertificateHighlightTheme,
} from '@prisma/client';
import { createCanvas } from 'canvas';

/**
 * Efeito de destaque ESTÁTICO (PNG, PDF, miniatura, prévia, impresso): a
 * versão em vetor do foil animado da página pública. Centro com a padronagem
 * escolhida, bem suave (multiplicado, para o texto continuar legível), e a
 * moldura com brilhos de formas e tamanhos sorteados. A sorte vem da chave do
 * certificado: o mesmo certificado sai sempre igual, e cada um é diferente.
 */

type Ctx = CanvasRenderingContext2D;

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

/**
 * Moldura em glitter: quadradinhos alinhados numa grade fina, de tamanhos e
 * brilhos sorteados (como foil holográfico). O sorteio é feito num quarto da
 * página e espelhado nos outros três, então a borda fica simétrica.
 */
function drawEdgeSparkles(
  ctx: Ctx,
  w: number,
  h: number,
  band: number,
  colors: string[],
  rand: () => number,
) {
  const unit = Math.min(w, h);
  const cell = Math.max(2, unit * 0.0065);
  const halfW = w / 2;
  const halfH = h / 2;
  for (let gy = 0; gy * cell < halfH; gy++) {
    for (let gx = 0; gx * cell < halfW; gx++) {
      const x = gx * cell;
      const y = gy * cell;
      // só na faixa da borda, mais denso perto da beirada
      const dist = Math.min(x, y);
      if (dist > band) continue;
      const edge = 1 - dist / band;
      if (rand() > 0.4 + edge * 0.5) continue;
      const t = rand();
      const glint = t > 0.88;
      const size = cell * (glint ? 0.85 : 0.3 + t * t * 0.6);
      const off = (cell - size) / 2;
      ctx.globalAlpha = glint ? 1 : 0.45 + rand() * 0.5 * (0.6 + edge * 0.4);
      ctx.fillStyle = glint ? colors[colors.length - 1] : colors[Math.floor(rand() * colors.length)];
      const px = x + off;
      const py = y + off;
      ctx.fillRect(px, py, size, size);
      ctx.fillRect(w - px - size, py, size, size);
      ctx.fillRect(px, h - py - size, size, size);
      ctx.fillRect(w - px - size, h - py - size, size, size);
    }
  }
  ctx.globalAlpha = 1;
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
) {
  const colors = PALETTE[theme] ?? PALETTE.ouro;
  const rand = rng(`${seed}|${theme}|${pattern}`);
  const band = Math.min(width, height) * 0.045;

  ctx.save();
  // centro: suave, multiplicado (tinge o papel e deixa o texto legível)
  if (pattern !== 'nenhum') {
    // camada própria: a opacidade e o multiply valem para a padronagem toda
    const cw = Math.max(1, Math.round(width - band * 2));
    const ch = Math.max(1, Math.round(height - band * 2));
    const layer = createCanvas(cw, ch);
    const lctx = layer.getContext('2d') as unknown as Ctx;
    drawCenterPattern(lctx, 0, 0, cw, ch, pattern, colors, rand);
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha =
      pattern === 'arco_iris' ? 0.22 : pattern === 'espiral' ? 0.12 : 0.3;
    ctx.drawImage(layer as unknown as CanvasImageSource, band, band);
    ctx.restore();
  }
  // moldura: brilhos por cima, nítidos
  drawEdgeSparkles(ctx, width, height, band, colors, rand);
  ctx.restore();
}
