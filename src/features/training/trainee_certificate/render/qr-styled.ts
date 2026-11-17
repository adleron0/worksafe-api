import { createCanvas } from 'canvas';
import * as QRCode from 'qrcode';
import { LOGO_GATE, LOGO_INNER, LOGO_OUTER, tracePath } from './highlight-seal';

/**
 * QR de validação desenhado à mão: fundo transparente, módulos arredondados e
 * os três "olhos" com cantos suaves, na cor do texto do certificado. Mantém
 * correção de erro alta (H), então continua lendo bem mesmo estilizado.
 */
export type QrStyle = 'pontos' | 'suave' | 'quadrado' | 'selo';
/** Estilos aceitos no marcador do QR (`qrStyle`); o resto cai no padrão. */
export const QR_STYLES: QrStyle[] = ['suave', 'quadrado', 'selo'];

export function styledQrPng(
  text: string,
  options: {
    size?: number;
    color?: string;
    style?: QrStyle;
    accent?: string;
    logo?: boolean;
  } = {},
): { buffer: Buffer; width: number; height: number } {
  const size = options.size ?? 600;
  const color = options.color ?? '#26282b';
  const eye = options.accent ?? color;
  const style = options.style ?? 'suave';
  // com logo no centro precisa de correção alta (H); sem logo, M basta e
  // deixa o QR com menos módulos (maiores, mais limpos e fáceis de ler)
  const withLogo = options.logo ?? style !== 'selo';
  const qr = QRCode.create(text, {
    errorCorrectionLevel: withLogo ? 'H' : 'M',
  });
  const n = qr.modules.size;
  const data = qr.modules.data;
  const cell = size / n;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // zona central limpa para o mosquetão (correção H tolera ~30% de perda)
  // no estilo "selo" a marca já está ao lado (SELO + mosquetão): QR limpo
  const logo = withLogo;
  const zone = Math.round(n * 0.26) | 1;
  const z0 = Math.floor((n - zone) / 2);
  const inLogo = (r: number, c: number) =>
    logo && r >= z0 && r < z0 + zone && c >= z0 && c < z0 + zone;
  const isEye = (r: number, c: number) =>
    (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  const dark = (r: number, c: number) =>
    r >= 0 && c >= 0 && r < n && c < n && !!data[r * n + c];

  const roundRect = (
    x: number,
    y: number,
    w: number,
    h: number,
    rad: number,
  ) => {
    const rr = Math.min(rad, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  };

  // módulos de dados
  ctx.fillStyle = color;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!dark(r, c) || isEye(r, c) || inLogo(r, c)) continue;
      const x = c * cell;
      const y = r * cell;
      if (style === 'pontos') {
        ctx.beginPath();
        ctx.arc(x + cell / 2, y + cell / 2, cell * 0.42, 0, Math.PI * 2);
        ctx.fill();
      } else if (style === 'suave') {
        // liga vizinhos (horizontal/vertical) para formar traços arredondados
        const g = cell * 0.08;
        roundRect(x + g, y + g, cell - 2 * g, cell - 2 * g, cell * 0.38);
        ctx.fill();
        if (dark(r, c + 1) && !isEye(r, c + 1) && !inLogo(r, c + 1))
          ctx.fillRect(x + cell / 2, y + g, cell, cell - 2 * g);
        if (dark(r + 1, c) && !isEye(r + 1, c) && !inLogo(r + 1, c))
          ctx.fillRect(x + g, y + cell / 2, cell - 2 * g, cell);
      } else {
        // módulos retos, levemente sobrepostos para não aparecer fresta
        ctx.fillRect(x - 0.3, y - 0.3, cell + 0.6, cell + 0.6);
      }
    }
  }

  // olhos: anel 7×7 + miolo 3×3 (retos no "selo"/"quadrado", suaves no resto)
  const square = style === 'selo' || style === 'quadrado';
  ctx.fillStyle = eye;
  for (const [er, ec] of [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ]) {
    const x = ec * cell;
    const y = er * cell;
    const k = square ? 0 : 1;
    ctx.beginPath();
    roundRect(x, y, 7 * cell, 7 * cell, cell * 2 * k);
    ctx.fill();
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    roundRect(x + cell, y + cell, 5 * cell, 5 * cell, cell * 1.3 * k);
    ctx.fill();
    ctx.restore();
    roundRect(x + 2 * cell, y + 2 * cell, 3 * cell, 3 * cell, cell * 0.9 * k);
    ctx.fill();
  }

  // mosquetão da marca no centro (corpo chumbo, trava vermelha)
  if (logo) {
    const box = zone * cell * 0.78;
    const k = box / 43.8; // altura do logo no viewBox
    ctx.save();
    ctx.translate(size / 2 - (30.87 * k) / 2, size / 2 - box / 2);
    ctx.scale(k, k);
    // corpo com a abertura interna (como no logo)
    tracePath(ctx as unknown as CanvasRenderingContext2D, LOGO_OUTER);
    tracePath(ctx as unknown as CanvasRenderingContext2D, LOGO_INNER, false);
    ctx.fillStyle = color;
    ctx.fill('evenodd');
    tracePath(ctx as unknown as CanvasRenderingContext2D, LOGO_GATE);
    ctx.fillStyle = '#ed2232';
    ctx.fill();
    ctx.restore();
  }

  return { buffer: canvas.toBuffer('image/png'), width: size, height: size };
}
