import { CertificateHighlightTheme } from '@prisma/client';

/**
 * Selo de destaque estático — desenhado no canvas do render (node-canvas),
 * por cima do certificado, para PNG, PDF, miniatura e prévia de redes sociais.
 * É o "par" impresso do brilho animado da página pública: gradientes que
 * imitam metal (ouro/prata) e furta-cor (holográfico), pensados para sair bem
 * em impressora comum. Usa as fontes já registradas pelo fabric-setup.
 */

type Ctx = CanvasRenderingContext2D;

interface Palette {
  /** Gradiente do metal (claro no meio = reflexo). */
  metal: string[];
  /** Contorno e detalhes. */
  dark: string;
  /** Faixa. */
  ribbon: string;
  ribbonDark: string;
  ribbonText: string;
  /** Riscas finas de "foil" por cima (só holográfico). */
  foil?: boolean;
}

const PALETTES: Record<CertificateHighlightTheme, Palette> = {
  ouro: {
    metal: ['#7a4a00', '#c99a2e', '#ffeaa8', '#d9a93c', '#8a5a00'],
    dark: '#6b4300',
    ribbon: '#a5740f',
    ribbonDark: '#6b4300',
    ribbonText: '#fff8e1',
  },
  prata: {
    metal: ['#4a545c', '#9aa5ae', '#ffffff', '#b8c2ca', '#56616a'],
    dark: '#3b444b',
    ribbon: '#66737d',
    ribbonDark: '#3b444b',
    ribbonText: '#ffffff',
  },
  holografico: {
    metal: ['#ff8ad8', '#8fd8ff', '#c4ffb3', '#ffe28f', '#c99cff'],
    dark: '#5b3f93',
    ribbon: '#7458bf',
    ribbonDark: '#4a3282',
    ribbonText: '#ffffff',
    foil: true,
  },
};

export interface SealBox {
  /** Canto superior esquerdo e lado do quadrado da roseta, em px do canvas. */
  x: number;
  y: number;
  size: number;
}

const metalGradient = (
  ctx: Ctx,
  cx: number,
  cy: number,
  r: number,
  stops: string[],
  reverse = false,
) => {
  const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  const list = reverse ? [...stops].reverse() : stops;
  list.forEach((c, i) => g.addColorStop(i / (list.length - 1), c));
  return g;
};

const starPath = (
  ctx: Ctx,
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  points: number,
  rotation = -Math.PI / 2,
) => {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rotation + (i * Math.PI) / points;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
};

/** Ajusta o tamanho da fonte para o texto caber na largura. */
const fitFont = (
  ctx: Ctx,
  text: string,
  maxWidth: number,
  maxPx: number,
  weight = 700,
  family = 'Montserrat',
) => {
  let px = maxPx;
  ctx.font = `${weight} ${px}px "${family}"`;
  while (px > 6 && ctx.measureText(text).width > maxWidth) {
    px -= 0.5;
    ctx.font = `${weight} ${px}px "${family}"`;
  }
  return px;
};

/**
 * Desenha a roseta + faixa. `box` é o quadrado da roseta; a faixa com o texto
 * desce um pouco abaixo dele (≈ 18% do lado) e a legenda opcional mais um tanto.
 */
export function drawHighlightSeal(
  ctx: Ctx,
  box: SealBox,
  theme: CertificateHighlightTheme,
  label: string,
  caption?: string | null,
) {
  const p = PALETTES[theme] ?? PALETTES.ouro;
  const R = box.size / 2;
  const cx = box.x + R;
  const cy = box.y + R;
  const lw = Math.max(1, R * 0.025);

  ctx.save();

  // sombra suave para "descolar" do papel
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = R * 0.12;
  ctx.shadowOffsetY = R * 0.04;

  // rabos da fita, atrás da roseta
  const tailW = R * 0.42;
  const tailTop = cy + R * 0.35;
  const tailBottom = cy + R * 1.25;
  for (const dir of [-1, 1]) {
    const x0 = cx + dir * R * 0.18;
    ctx.beginPath();
    ctx.moveTo(x0, tailTop);
    ctx.lineTo(x0 + dir * tailW, tailTop + R * 0.12);
    ctx.lineTo(x0 + dir * tailW * 0.9, tailBottom);
    ctx.lineTo(x0 + dir * tailW * 0.45, tailBottom - R * 0.16);
    ctx.lineTo(x0, tailBottom);
    ctx.closePath();
    ctx.fillStyle = dir < 0 ? p.ribbon : p.ribbonDark;
    ctx.fill();
  }

  // roseta serrilhada
  starPath(ctx, cx, cy, R, R * 0.9, 28);
  ctx.fillStyle = metalGradient(ctx, cx, cy, R, p.metal);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = lw;
  ctx.strokeStyle = p.dark;
  ctx.stroke();

  // anel e disco interno (gradiente invertido dá o relevo)
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.78, 0, Math.PI * 2);
  ctx.fillStyle = metalGradient(ctx, cx, cy, R * 0.78, p.metal, true);
  ctx.fill();
  ctx.lineWidth = lw * 1.4;
  ctx.strokeStyle = p.dark;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.68, 0, Math.PI * 2);
  ctx.lineWidth = lw;
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.setLineDash([R * 0.04, R * 0.035]);
  ctx.stroke();
  ctx.setLineDash([]);

  // estrela central
  starPath(ctx, cx, cy - R * 0.06, R * 0.36, R * 0.15, 5);
  ctx.fillStyle = metalGradient(ctx, cx, cy, R * 0.36, p.metal);
  ctx.fill();
  ctx.lineWidth = lw * 1.2;
  ctx.strokeStyle = p.dark;
  ctx.stroke();

  // "foil": riscas finas diagonais recortadas na roseta (holográfico)
  if (p.foil) {
    ctx.save();
    starPath(ctx, cx, cy, R, R * 0.9, 28);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = Math.max(1, R * 0.012);
    for (let k = -2 * R; k < 2 * R; k += R * 0.07) {
      ctx.beginPath();
      ctx.moveTo(cx + k - R, cy - R);
      ctx.lineTo(cx + k + R, cy + R);
      ctx.stroke();
    }
    ctx.restore();
  }

  // reflexo
  const shine = ctx.createLinearGradient(
    cx - R,
    cy - R,
    cx + R * 0.2,
    cy + R * 0.2,
  );
  shine.addColorStop(0, 'rgba(255,255,255,0.45)');
  shine.addColorStop(0.5, 'rgba(255,255,255,0)');
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.9, 0, Math.PI * 2);
  ctx.fillStyle = shine;
  ctx.fill();

  // faixa com o texto, cruzando a parte de baixo da roseta
  const text = label.toUpperCase();
  const bandW = R * 2.15;
  const bandH = R * 0.36;
  const bandX = cx - bandW / 2;
  const bandY = cy + R * 0.52;
  const notch = bandH * 0.45;
  ctx.shadowColor = 'rgba(0,0,0,0.2)';
  ctx.shadowBlur = R * 0.06;
  ctx.shadowOffsetY = R * 0.02;
  ctx.beginPath();
  ctx.moveTo(bandX - notch, bandY);
  ctx.lineTo(bandX + bandW + notch, bandY);
  ctx.lineTo(bandX + bandW + notch * 0.35, bandY + bandH / 2);
  ctx.lineTo(bandX + bandW + notch, bandY + bandH);
  ctx.lineTo(bandX - notch, bandY + bandH);
  ctx.lineTo(bandX - notch * 0.35, bandY + bandH / 2);
  ctx.closePath();
  const band = ctx.createLinearGradient(0, bandY, 0, bandY + bandH);
  band.addColorStop(0, p.ribbon);
  band.addColorStop(1, p.ribbonDark);
  ctx.fillStyle = band;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = lw;
  ctx.strokeStyle = p.ribbonDark;
  ctx.stroke();

  fitFont(ctx, text, bandW * 0.92, bandH * 0.58);
  ctx.fillStyle = p.ribbonText;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, bandY + bandH / 2 + bandH * 0.03);

  // legenda pequena (ex.: convite a verificar o selo digital pelo QR)
  if (caption) {
    const capY = tailBottom + R * 0.16;
    fitFont(ctx, caption, R * 2.6, R * 0.12, 400);
    ctx.fillStyle = 'rgba(60,60,60,0.85)';
    ctx.fillText(caption, cx, capY);
  }

  ctx.restore();
}

/** Altura total ocupada (roseta + rabos + legenda), em múltiplos do lado. */
export const SEAL_HEIGHT_RATIO = 1.32;
