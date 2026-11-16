/**
 * Brilho da moldura do destaque (estático: PNG, PDF, impressão).
 *
 * Cada estilo desenha só o canto superior esquerdo (um quarto da página) e o
 * resultado é espelhado nos outros três: a borda sai simétrica e o sorteio
 * (que vem da chave do certificado) é o mesmo nos quatro cantos.
 *
 * Todos são só partículas por cima da corda (nada de tingir):
 * - corda (padrão, "Trança" na tela): três fios de luz em curvas entrelaçadas
 * - reflexo: traços longos que acendem e apagam, em trilhas paralelas à borda
 * - glitter: quadradinhos de tamanhos e brilhos sorteados
 * - cristais: triângulos pequenos de tamanhos e giros sorteados
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

/** Largura da corda dos modelos (mais larga que a faixa do glitter). */
const ropeBand = (w: number, h: number) => Math.min(w, h) * 0.066;

/**
 * Partículas na faixa da corda (canto superior esquerdo): sorteia posições
 * numa grade fina, mais densas perto da beirada, e chama `draw` em cada uma.
 * Nada de tingir ou cobrir a corda: só pontos de brilho por cima dela.
 */
function particles(
  w: number,
  h: number,
  B: number,
  cell: number,
  density: number,
  rand: () => number,
  draw: (x: number, y: number, t: number, edge: number) => void,
) {
  for (let gy = 0; gy * cell < h / 2; gy++) {
    for (let gx = 0; gx * cell < w / 2; gx++) {
      const x = (gx + 0.15 + rand() * 0.7) * cell;
      const y = (gy + 0.15 + rand() * 0.7) * cell;
      const dist = Math.min(x, y);
      if (dist > B) continue;
      const edge = 1 - dist / B;
      if (rand() > density * (0.55 + edge * 0.45)) continue;
      draw(x, y, rand(), edge);
    }
  }
}

/**
 * Faixa da borda "desenrolada": `drawStrip(L)` desenha numa tira horizontal de
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

function rgba(hex: string, a: number) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
}

/**
 * Trança (id "corda"): três fios finos de luz em curvas que se entrelaçam
 * como uma trança de três pernas, por cima da corda. Cada fio acende no alto
 * da curva (onde a luz bateria) e quase some no vale, então o desenho tem
 * volume sem cobrir a corda; nos cruzamentos mais acesos, um ponto de brilho.
 */
function drawCorda(ctx: Ctx, w: number, h: number, colors: string[], rand: () => number) {
  const B = ropeBand(w, h);
  const unit = Math.min(w, h);
  const light = colors[colors.length - 1];
  const gold = colors[0];
  const yc = B * 0.5;
  const amp = B * 0.3;
  const period = B * 1.35;
  const phase0 = rand() * Math.PI * 2;
  edgeStrips(ctx, w, h, B, (L) => {
    // fios contínuos e finos (pontas retas: sem o efeito de contas)
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    const step = period / 40;
    const crests: Array<[number, number, number]> = []; // x, y, ângulo do fio
    for (let k = 0; k < 3; k++) {
      const ph = phase0 + (k * Math.PI * 2) / 3;
      let prev: [number, number] | null = null;
      for (let x = -period; x <= L + period; x += step) {
        const th = (x / period) * Math.PI * 2 + ph;
        const y = yc + amp * Math.sin(th);
        // 0..1: onde a luz bate — cada fio acende numa altura, espalhando o brilho
        const lit = Math.max(0, Math.cos(th - 0.6 - k * 2.1));
        if (prev) {
          // fio dourado bem fino, mais visível onde a luz bate
          ctx.globalAlpha = 0.18 + lit * lit * 0.75;
          ctx.strokeStyle = gold;
          ctx.lineWidth = unit * (0.001 + lit * 0.0013);
          ctx.beginPath();
          ctx.moveTo(prev[0], prev[1]);
          ctx.lineTo(x, y);
          ctx.stroke();
          // filete claro só no trecho mais aceso
          if (lit > 0.7) {
            ctx.globalAlpha = (lit - 0.7) * 3;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = unit * 0.0006;
            ctx.beginPath();
            ctx.moveTo(prev[0], prev[1]);
            ctx.lineTo(x, y);
            ctx.stroke();
          }
          // trechos acesos: candidatos a ponto de brilho (espalhados, não só no pico)
          if (lit > 0.75 && rand() < 0.05) crests.push([x, y, Math.atan2(y - prev[1], x - prev[0])]);
        }
        prev = [x, y];
      }
    }
    // pontos de luz suaves em alguns picos — o "brilho" da trança
    ctx.globalCompositeOperation = 'lighter';
    for (const [x, y, ang] of crests) {
      const r = unit * (0.003 + rand() * 0.004);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba('#ffffff', 0.9));
      g.addColorStop(0.25, rgba(light, 0.55));
      g.addColorStop(1, rgba(light, 0));
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      // reflexo fino ao longo do fio (traço curto e aceso)
      ctx.strokeStyle = rgba('#ffffff', 0.8);
      ctx.lineWidth = unit * 0.0007;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(ang) * r * 1.4, y - Math.sin(ang) * r * 1.4);
      ctx.lineTo(x + Math.cos(ang) * r * 1.4, y + Math.sin(ang) * r * 1.4);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  });
}

/**
 * Reflexo: traços longos e finíssimos que acendem e apagam nas pontas
 * (degradê transparente → ouro → branco → ouro → transparente), em três
 * trilhas paralelas à borda, com espaçamento irregular — luz correndo pela
 * moldura.
 */
function drawReflexo(ctx: Ctx, w: number, h: number, colors: string[], rand: () => number) {
  const B = ropeBand(w, h);
  const unit = Math.min(w, h);
  const light = colors[colors.length - 1];
  const gold = colors[0];
  const deep = colors[3] ?? colors[1] ?? gold;
  const lanes = [0.22, 0.5, 0.78];
  edgeStrips(ctx, w, h, B, (L) => {
    ctx.lineCap = 'round';
    lanes.forEach((lane, li) => {
      let x = -B + rand() * B;
      while (x < L) {
        const len = B * (1.2 + rand() * 2.6);
        const y = B * lane + (rand() - 0.5) * B * 0.06;
        const peak = 0.75 + rand() * 0.25;
        const g = ctx.createLinearGradient(x, 0, x + len, 0);
        g.addColorStop(0, rgba(gold, 0));
        g.addColorStop(0.35, rgba(gold, peak * 0.8));
        g.addColorStop(0.5, rgba(light, peak));
        g.addColorStop(0.65, rgba(gold, peak * 0.8));
        g.addColorStop(1, rgba(gold, 0));
        const line = (width: number, alpha: number, style: string | CanvasGradient) => {
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = style;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + len, y);
          ctx.stroke();
        };
        const base = unit * (li === 1 ? 0.0034 : 0.0024);
        // halo largo e suave + traço fino aceso
        const halo = ctx.createLinearGradient(x, 0, x + len, 0);
        halo.addColorStop(0, rgba(deep, 0));
        halo.addColorStop(0.5, rgba(deep, 0.55));
        halo.addColorStop(1, rgba(deep, 0));
        line(base * 2.2, 1, halo);
        line(base, 1, g);
        x += len + B * (0.6 + rand() * 2.2);
      }
    });
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

/** Cristais: só triângulos pequenos, de tamanhos, giros e brilhos sorteados. */
function drawCristais(ctx: Ctx, w: number, h: number, colors: string[], rand: () => number) {
  const B = ropeBand(w, h);
  const unit = Math.min(w, h);
  const cell = unit * 0.009;
  const light = colors[colors.length - 1];
  particles(w, h, B, cell, 0.6, rand, (x, y, t) => {
    const bright = t > 0.9;
    const r = cell * (bright ? 0.75 : 0.25 + t * t * 0.45);
    const rot = rand() * Math.PI * 2;
    ctx.globalAlpha = bright ? 1 : 0.4 + rand() * 0.5;
    ctx.fillStyle = bright ? light : colors[Math.floor(rand() * colors.length)];
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = rot + (i * Math.PI * 2) / 3;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
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
