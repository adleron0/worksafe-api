/**
 * Brilho da moldura do destaque (estático: PNG, PDF, impressão).
 *
 * Cada estilo desenha só o canto superior esquerdo (um quarto da página) e o
 * resultado é espelhado nos outros três: a borda sai simétrica e o sorteio
 * (que vem da chave do certificado) é o mesmo nos quatro cantos.
 *
 * - corda (padrão): tinge a corda da moldura na cor do tema e trança fios
 *   finos de luz nas duas diagonais, com reflexos correndo por ela
 * - reflexo: a corda tingida com faixas de luz largas e calmas
 * - glitter: quadradinhos de tamanhos e brilhos sorteados
 * - cristais: losangos facetados, como vidro lapidado
 * - nenhum: sem brilho (só a moldura do modelo)
 */
export const FOIL_BORDERS = ['corda', 'reflexo', 'glitter', 'cristais', 'nenhum'] as const;
export type FoilBorder = (typeof FOIL_BORDERS)[number];
export const DEFAULT_FOIL_BORDER: FoilBorder = 'corda';

type Ctx = CanvasRenderingContext2D;

export function isFoilBorder(v: unknown): v is FoilBorder {
  return typeof v === 'string' && (FOIL_BORDERS as readonly string[]).includes(v);
}

/** Desenha `draw` no quarto superior esquerdo e espelha nos outros três. */
function mirrored(ctx: Ctx, w: number, h: number, draw: () => void) {
  const flips: Array<[number, number]> = [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ];
  for (const [sx, sy] of flips) {
    ctx.save();
    ctx.translate(sx < 0 ? w : 0, sy < 0 ? h : 0);
    ctx.scale(sx, sy);
    ctx.beginPath();
    ctx.rect(0, 0, w / 2 + 0.5, h / 2 + 0.5);
    ctx.clip();
    draw();
    ctx.restore();
  }
}

/** Brilho do reflexo ao longo da borda: ondas suaves (0..1). */
function shimmer(pos: number, period: number, phase: number) {
  const s = 0.5 + 0.5 * Math.sin((pos / period) * Math.PI * 2 + phase);
  return s * s;
}

/** Largura da corda dos modelos (mais larga que a faixa do glitter). */
const ropeBand = (w: number, h: number) => Math.min(w, h) * 0.066;

/**
 * Faixa da borda "desenrolada": `drawStrip(L)` desenha uma tira horizontal de
 * comprimento L e altura B (o topo); a lateral é a mesma tira transposta. O
 * canto é dividido na diagonal, então nada é desenhado duas vezes.
 */
function edgeStrips(ctx: Ctx, w: number, h: number, B: number, drawStrip: (L: number) => void) {
  for (const side of ['top', 'left'] as const) {
    ctx.save();
    if (side === 'left') ctx.transform(0, 1, 1, 0, 0, 0); // (x,y) -> (y,x)
    const L = (side === 'top' ? w : h) / 2 + 1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(L, 0);
    ctx.lineTo(L, B);
    ctx.lineTo(B, B);
    ctx.closePath();
    ctx.clip();
    drawStrip(L);
    ctx.restore();
  }
}

/** Tinge a corda do fundo com as cores do tema (a prata vira ouro, holográfico…). */
function tintStrip(ctx: Ctx, L: number, B: number, colors: string[], alpha: number) {
  const g = ctx.createLinearGradient(0, 0, L, 0);
  const n = Math.max(2, Math.round(L / (B * 3)));
  for (let i = 0; i <= n; i++) g.addColorStop(i / n, colors[i % colors.length]);
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, L, B);
}

/** Faixas de luz inclinadas, suaves, que "correm" pela moldura. */
function sweepStrip(ctx: Ctx, L: number, B: number, period: number, phase: number, maxA: number) {
  ctx.save();
  ctx.transform(1, 0, -0.7, 1, 0, 0); // inclina as faixas
  const x0 = -B;
  const x1 = L + B * 2;
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  const steps = Math.ceil((x1 - x0) / (period / 10));
  for (let i = 0; i <= steps; i++) {
    const x = x0 + (i / steps) * (x1 - x0);
    const a = Math.pow(shimmer(x, period, phase), 3) * maxA;
    g.addColorStop(i / steps, `rgba(255,255,255,${a.toFixed(3)})`);
  }
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.fillRect(x0, 0, x1 - x0, B);
  ctx.restore();
}

/**
 * Corda: tinge a corda, passa reflexos inclinados e trança fios finos de luz
 * nas duas diagonais (por cima/por baixo, como trama), com intensidade
 * acompanhando os reflexos — os fios se misturam à corda (screen).
 */
function drawCorda(ctx: Ctx, w: number, h: number, colors: string[], rand: () => number) {
  const B = ropeBand(w, h);
  const phase = rand() * Math.PI * 2;
  const period = B * 7;
  const light = colors[colors.length - 1];
  edgeStrips(ctx, w, h, B, (L) => {
    tintStrip(ctx, L, B, colors, 0.5);
    sweepStrip(ctx, L, B, period, phase, 0.55);
    ctx.globalCompositeOperation = 'screen';
    ctx.lineCap = 'round';
    const step = B * 0.3;
    const slope = 0.75; // inclinação dos fios (x por y)
    const parts = 4;
    for (const dir of [1, -1]) {
      for (let x0 = -B * 2; x0 < L + B * 2; x0 += step) {
        for (let k = 0; k < parts; k++) {
          const y0 = (k / parts) * B;
          const y1 = ((k + 1) / parts) * B;
          const xa = x0 + dir * slope * y0;
          const xb = x0 + dir * slope * y1;
          const glow = shimmer((xa + xb) / 2 + (dir > 0 ? 0 : period * 0.18), period, phase);
          const over = (Math.round(x0 / step) + k + (dir > 0 ? 0 : 1)) % 2 === 0;
          const a = (over ? 0.55 : 0.18) * (0.25 + glow * 0.75);
          ctx.globalAlpha = a;
          ctx.strokeStyle = light;
          ctx.lineWidth = B * 0.045;
          ctx.beginPath();
          ctx.moveTo(xa, y0);
          ctx.lineTo(xb, y1);
          ctx.stroke();
          if (over && glow > 0.6) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = B * 0.016;
            ctx.beginPath();
            ctx.moveTo(xa, y0);
            ctx.lineTo(xb, y1);
            ctx.stroke();
          }
        }
      }
    }
  });
}

/** Reflexo: só a corda tingida e faixas de luz largas e calmas. */
function drawReflexo(ctx: Ctx, w: number, h: number, colors: string[], rand: () => number) {
  const B = ropeBand(w, h);
  const phase = rand() * Math.PI * 2;
  edgeStrips(ctx, w, h, B, (L) => {
    tintStrip(ctx, L, B, colors, 0.55);
    sweepStrip(ctx, L, B, B * 10, phase, 0.7);
  });
}

/** Glitter: quadradinhos numa grade fina, de tamanhos e brilhos sorteados. */
function drawGlitter(ctx: Ctx, w: number, h: number, colors: string[], rand: () => number) {
  const unit = Math.min(w, h);
  const band = unit * 0.045;
  const cell = Math.max(2, unit * 0.0065);
  for (let gy = 0; gy * cell < h / 2; gy++) {
    for (let gx = 0; gx * cell < w / 2; gx++) {
      const x = gx * cell;
      const y = gy * cell;
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
      ctx.fillRect(x + off, y + off, size, size);
    }
  }
}

/** Cristais: losangos sobre a corda, cada faceta com um brilho e um corte claro. */
function drawCristais(ctx: Ctx, w: number, h: number, colors: string[], rand: () => number) {
  const B = ropeBand(w, h);
  const s = B * 0.26; // meia diagonal do losango
  edgeStrips(ctx, w, h, B, (L) => {
    tintStrip(ctx, L, B, colors, 0.35);
    for (let row = 0; row * s <= B + s; row++) {
      for (let col = -1; col * s * 2 < L + s * 2; col++) {
        const cx = col * s * 2 + (row % 2 ? s : 0);
        const cy = row * s;
        const t = rand();
        if (t > 0.7) continue;
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = 0.2 + t * 0.35;
        ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
        ctx.beginPath();
        ctx.moveTo(cx, cy - s);
        ctx.lineTo(cx + s, cy);
        ctx.lineTo(cx, cy + s);
        ctx.lineTo(cx - s, cy);
        ctx.closePath();
        ctx.fill();
        // corte claro na metade de cima da faceta
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.25 + t * 0.6;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(cx, cy - s);
        ctx.lineTo(cx + s * 0.6, cy - s * 0.15);
        ctx.lineTo(cx - s * 0.4, cy - s * 0.3);
        ctx.closePath();
        ctx.fill();
      }
    }
  });
}

/** Desenha o brilho da moldura no estilo escolhido. */
export function drawFoilBorder(
  ctx: Ctx,
  w: number,
  h: number,
  colors: string[],
  makeRand: () => () => number,
  border: FoilBorder,
) {
  if (border === 'nenhum') return;
  const draw = {
    corda: drawCorda,
    reflexo: drawReflexo,
    glitter: drawGlitter,
    cristais: drawCristais,
  }[border] ?? drawCorda;
  // mesmo sorteio nos quatro cantos: um gerador novo, igual, por quarto
  mirrored(ctx, w, h, () => {
    ctx.save();
    draw(ctx, w, h, colors, makeRand());
    ctx.restore();
  });
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}
