/**
 * Brilho da moldura do destaque (estático: PNG, PDF, impressão).
 *
 * Cada estilo desenha só o canto superior esquerdo (um quarto da página) e o
 * resultado é espelhado nos outros três: a borda sai simétrica e o sorteio
 * (que vem da chave do certificado) é o mesmo nos quatro cantos.
 *
 * Todos são só partículas por cima da corda (nada de tingir):
 * - corda (padrão, "Trança" na tela): três fios de luz em curvas entrelaçadas
 * - reflexo: faixas inclinadas de poeira brilhante, como luz passando sobre metal
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
    const along: Array<[number, number, number]> = []; // x, y, luz — para o glitter dos fios
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
          ctx.globalAlpha = 0.4 + lit * 0.5;
          ctx.strokeStyle = gold;
          ctx.lineWidth = unit * (0.0012 + lit * 0.0016);
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
          along.push([x, y, lit]);
          // trechos acesos: candidatos a ponto de brilho (espalhados, não só no pico)
          if (lit > 0.75 && rand() < 0.05) crests.push([x, y, Math.atan2(y - prev[1], x - prev[0])]);
        }
        prev = [x, y];
      }
    }
    // glitter preso nos fios: quadradinhos e triângulos pequenos, mais densos
    // onde a luz bate, alguns desgarrados por perto — dá o brilho da trança
    for (const [x0, y0, lit] of along) {
      // pelo fio inteiro; a luz só muda o brilho e o tamanho
      const n = rand() < 0.75 ? 1 : 2;
      for (let i = 0; i < n; i++) {
        const spread = B * (rand() < 0.85 ? 0.05 : 0.18);
        const x = x0 + (rand() - 0.5) * 2 * spread;
        const y = y0 + (rand() - 0.5) * 2 * spread;
        const t = rand();
        const glint = t > 0.93;
        const size = unit * (glint ? 0.0034 : 0.0012 + t * t * 0.0022);
        ctx.globalAlpha = glint ? 1 : 0.4 + (0.3 + lit * 0.3) * rand();
        ctx.fillStyle = glint || rand() < 0.15 ? light : colors[Math.floor(rand() * colors.length)];
        if (rand() < 0.6) {
          ctx.fillRect(x - size / 2, y - size / 2, size, size);
        } else {
          const rot = rand() * Math.PI * 2;
          ctx.beginPath();
          for (let k = 0; k < 3; k++) {
            const a = rot + (k * Math.PI * 2) / 3;
            const px = x + Math.cos(a) * size * 0.75;
            const py = y + Math.sin(a) * size * 0.75;
            if (k === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
        }
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
 * Reflexo: faixas inclinadas de poeira brilhante, como a luz passando sobre
 * metal. Em cada faixa, quadradinhos finíssimos se concentram no meio e se
 * dissolvem nas bordas (distribuição gaussiana), somando luz ("lighter");
 * um ou dois pontos nítidos marcam o centro do reflexo. Entre as faixas a
 * corda fica limpa.
 */
function drawReflexo(ctx: Ctx, w: number, h: number, colors: string[], rand: () => number) {
  const B = ropeBand(w, h);
  const unit = Math.min(w, h);
  const light = colors[colors.length - 1];
  const gauss = () => (rand() + rand() + rand() - 1.5) / 1.5; // ~N(0, 0.33), em -1..1
  const slant = Math.tan(Math.PI / 6); // inclinação das faixas
  edgeStrips(ctx, w, h, B, (L) => {
    let c = B * (0.5 + rand() * 1.5);
    while (c < L + B) {
      const width = B * (0.35 + rand() * 0.35); // meia largura da faixa
      const strength = 0.6 + rand() * 0.4;
      const count = Math.round(320 * strength);
      for (let i = 0; i < count; i++) {
        const u = gauss(); // posição através da faixa (-1..1)
        const y = rand() * B;
        const x = c + u * width + (y - B / 2) * slant;
        const fall = Math.exp(-u * u * 4); // mais denso e aceso no meio
        const r = unit * (0.0005 + rand() * rand() * 0.0016) * (0.6 + fall * 0.7);
        ctx.globalAlpha = (0.3 + fall * 0.7) * strength;
        // poeira na cor do tema (aparece sobre a prata); pouco branco, só de brilho
        ctx.fillStyle = rand() < 0.15 ? '#ffffff' : colors[Math.floor(rand() * colors.length)];
        // quadradinhos (como o glitter), não bolinhas
        const side = r * 2;
        ctx.fillRect(x - side / 2, y - side / 2, side, side);
      }
      // um ou dois pontos nítidos no centro do reflexo, somando luz
      ctx.globalCompositeOperation = 'lighter';
      const n = rand() < 0.5 ? 1 : 2;
      for (let j = 0; j < n; j++) {
        const y = B * (0.25 + rand() * 0.5);
        const x = c + (y - B / 2) * slant + gauss() * width * 0.25;
        const r = unit * (0.0035 + rand() * 0.003);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, rgba('#ffffff', 0.95));
        g.addColorStop(0.3, rgba(light, 0.5));
        g.addColorStop(1, rgba(light, 0));
        ctx.globalAlpha = strength;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      c += B * (1.8 + rand() * 1.6);
    }
    ctx.globalCompositeOperation = 'source-over';
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
