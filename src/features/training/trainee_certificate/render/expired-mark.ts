/**
 * Carimbo "VENCIDO" sobre o certificado cuja validade já passou: diagonal,
 * vermelho translúcido, com moldura dupla e a data. Continua dando para ler
 * o certificado (é autêntico), mas o arquivo não circula como se valesse.
 *
 * O carimbo é desenhado RETO numa camada própria e só a camada é girada ao
 * colar: texto girado direto no contexto do fabric sai com ângulo errado.
 */
import { join } from 'path';
import { createCanvas } from 'canvas';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fontkit = require('fontkit');

type Ctx = CanvasRenderingContext2D;

const RED = '229, 33, 39';
const FONTS_DIR = join(process.cwd(), 'assets', 'fonts');

/*
 * As letras saem como CONTORNOS (fontkit), não com fillText: o node-canvas
 * guarda no cache de fontes a rotação de textos que o fabric desenhou antes
 * e reaplica em quem vier depois — o carimbo saía entortado.
 */
const fontCache = new Map<string, any>();
function font(file: string) {
  if (!fontCache.has(file)) {
    fontCache.set(file, fontkit.openSync(join(FONTS_DIR, file)));
  }
  return fontCache.get(file);
}

/** Largura do texto (px) com espaçamento extra entre letras. */
function textWidth(file: string, text: string, size: number, spacing = 0) {
  const f = font(file);
  const run = f.layout(text);
  const k = size / f.unitsPerEm;
  const adv = run.positions.reduce((a: number, p: any) => a + p.xAdvance, 0);
  return adv * k + spacing * Math.max(0, run.glyphs.length - 1);
}

/** Preenche o texto como formas, a partir da linha de base (x à esquerda). */
function fillTextPath(
  ctx: Ctx,
  file: string,
  text: string,
  size: number,
  x: number,
  baseline: number,
  spacing = 0,
) {
  const f = font(file);
  const run = f.layout(text);
  const k = size / f.unitsPerEm;
  let pen = x;
  run.glyphs.forEach((glyph: any, i: number) => {
    const pos = run.positions[i];
    ctx.save();
    ctx.translate(pen + pos.xOffset * k, baseline - pos.yOffset * k);
    ctx.scale(k, -k);
    ctx.beginPath();
    glyph.path.toFunction()(ctx);
    ctx.fill();
    ctx.restore();
    pen += pos.xAdvance * k + spacing;
  });
}
const ANGLE = (-16 * Math.PI) / 180;

/** Desenha o carimbo reto numa camada do tamanho exato dele. */
function stampLayer(width: number, expiredAt: Date) {
  const date = isNaN(expiredAt.getTime())
    ? ''
    : expiredAt.toLocaleDateString('pt-BR', { timeZone: 'America/Recife' });
  const big = Math.round(width * 0.12);
  const small = Math.round(big * 0.24);
  const title = 'VENCIDO';
  const line = date ? `VALIDADE ENCERRADA EM ${date}` : 'VALIDADE ENCERRADA';
  const sp = big * 0.1;

  const BEBAS = 'bebas-neue-400.ttf';
  const SANS = 'open-sans-700.ttf';
  const tw = textWidth(BEBAS, title, big, sp);
  const lw = textWidth(SANS, line, small);

  const pad = big * 0.22;
  const capH = big * 0.72;
  const boxW = Math.ceil(Math.max(tw, lw) + big * 0.7);
  const boxH = Math.ceil(pad + capH + small * 0.9 + small * 1.05 + pad);
  const stroke = Math.max(2, big * 0.045);
  const W = boxW + stroke * 2;
  const H = boxH + stroke * 2;

  const layer = createCanvas(W, H);
  const ctx = layer.getContext('2d') as unknown as Ctx;
  const ox = stroke;
  const oy = stroke;

  // moldura dupla
  ctx.strokeStyle = `rgba(${RED}, 0.42)`;
  ctx.lineWidth = stroke;
  roundRect(ctx, ox, oy, boxW, boxH, big * 0.12);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, big * 0.016);
  const g = big * 0.09;
  roundRect(ctx, ox + g, oy + g, boxW - 2 * g, boxH - 2 * g, big * 0.08);
  ctx.stroke();

  // título com espaçamento entre letras
  const base1 = oy + pad + capH;
  ctx.fillStyle = `rgba(${RED}, 0.36)`;
  fillTextPath(ctx, BEBAS, title, big, ox + (boxW - tw) / 2, base1, sp);

  // data
  ctx.fillStyle = `rgba(${RED}, 0.5)`;
  fillTextPath(
    ctx,
    SANS,
    line,
    small,
    ox + (boxW - lw) / 2,
    base1 + small * 0.9 + small,
  );

  return layer;
}

function roundRect(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawExpiredMark(
  ctx: Ctx,
  width: number,
  height: number,
  expiredAt: Date,
) {
  const layer = stampLayer(width, expiredAt);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.translate(width / 2, height / 2);
  ctx.rotate(ANGLE);
  ctx.drawImage(
    layer as unknown as CanvasImageSource,
    -layer.width / 2,
    -layer.height / 2,
  );
  ctx.restore();
}
