import * as sharp from 'sharp';
import { compressImage, MAX_SIDE, SKIP_BELOW_BYTES } from './image-compress';

/** Foto "real" o bastante para pesar: ruído colorido (não comprime trivialmente). */
async function noisyImage(width: number, height: number, format: 'jpeg' | 'png' | 'webp', alpha = false) {
  const channels = alpha ? 4 : 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) % 251;
  if (alpha) for (let i = 3; i < raw.length; i += 4) raw[i] = i % 8 === 3 ? 0 : 255;
  const img = sharp(raw, { raw: { width, height, channels } });
  if (format === 'jpeg') return img.jpeg({ quality: 98 }).toBuffer();
  if (format === 'webp') return img.webp({ quality: 100 }).toBuffer();
  return img.png({ compressionLevel: 0 }).toBuffer();
}

describe('compressImage (fotos enviadas pelo sistema)', () => {
  it('JPEG grande fica menor, continua JPEG e cabe em MAX_SIDE', async () => {
    const input = await noisyImage(3000, 2000, 'jpeg');
    const out = await compressImage(input, 'image/jpeg');
    expect(out.changed).toBe(true);
    expect(out.mimetype).toBe('image/jpeg');
    expect(out.buffer.length).toBeLessThan(input.length);
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(MAX_SIDE);
  });

  it('PNG com transparência (assinatura, logo) continua PNG com transparência', async () => {
    const input = await noisyImage(900, 400, 'png', true);
    const out = await compressImage(input, 'image/png');
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe('png');
    expect(meta.hasAlpha).toBe(true);
    expect(out.buffer.length).toBeLessThanOrEqual(input.length);
  });

  it('PNG sem transparência (foto salva em PNG) vira JPEG menor', async () => {
    const input = await noisyImage(1200, 900, 'png');
    const out = await compressImage(input, 'image/png');
    expect(out.mimetype).toBe('image/jpeg');
    expect((await sharp(out.buffer).metadata()).format).toBe('jpeg');
    expect(out.buffer.length).toBeLessThan(input.length / 2);
  });

  it('WebP continua WebP', async () => {
    const input = await noisyImage(2400, 1600, 'webp');
    const out = await compressImage(input, 'image/webp');
    expect((await sharp(out.buffer).metadata()).format).toBe('webp');
  });

  it('imagem leve, SVG e GIF passam intactos', async () => {
    const small = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#149E5E' } }).jpeg().toBuffer();
    expect(small.length).toBeLessThan(SKIP_BELOW_BYTES);
    expect((await compressImage(small, 'image/jpeg')).buffer).toBe(small);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'.padEnd(SKIP_BELOW_BYTES + 10, ' '));
    expect((await compressImage(svg, 'image/svg+xml')).buffer).toBe(svg);

    const gif = Buffer.alloc(SKIP_BELOW_BYTES + 10, 1);
    expect((await compressImage(gif, 'image/gif')).buffer).toBe(gif);
  });

  it('arquivo corrompido não quebra o envio: sobe como veio', async () => {
    const junk = Buffer.alloc(SKIP_BELOW_BYTES + 10, 7);
    const out = await compressImage(junk, 'image/jpeg');
    expect(out.changed).toBe(false);
    expect(out.buffer).toBe(junk);
  });
});
