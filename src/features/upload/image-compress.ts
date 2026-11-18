import * as sharp from 'sharp';

/** Maior lado depois da compressão: as fotos aparecem com até ~800 px na tela; 1600 cobre retina. */
export const MAX_SIDE = 1600;
/** Abaixo disso a imagem já é leve: vai como chegou. */
export const SKIP_BELOW_BYTES = 150 * 1024;

export interface CompressedImage {
  buffer: Buffer;
  mimetype: string;
  /** false quando a imagem foi mantida como chegou */
  changed: boolean;
}

const keep = (buffer: Buffer, mimetype: string): CompressedImage => ({ buffer, mimetype, changed: false });

/**
 * Comprime a foto enviada sem mudar o formato (o render de certificados e o
 * site leem estas URLs): JPEG continua JPEG, PNG com transparência continua PNG
 * (assinatura, logo), PNG sem transparência (foto) vira JPEG, WebP continua WebP. Reduz o maior lado a
 * MAX_SIDE e corrige a rotação do celular (EXIF). SVG, GIF (animação) e
 * qualquer coisa que o sharp não leia passam intactos. Só troca se ficar menor.
 */
export async function compressImage(buffer: Buffer, mimetype: string): Promise<CompressedImage> {
  const type = (mimetype || '').toLowerCase();
  if (!/^image\/(jpeg|jpg|pjpeg|png|webp)$/.test(type)) return keep(buffer, mimetype);
  if (buffer.length <= SKIP_BELOW_BYTES) return keep(buffer, mimetype);

  try {
    const image = sharp(buffer, { failOn: 'none' }).rotate();
    const meta = await image.metadata();
    const big = Math.max(meta.width ?? 0, meta.height ?? 0) > MAX_SIDE;
    const sized = big ? image.resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }) : image;

    let out: Buffer;
    let outType = type;
    // PNG sem transparência é foto salva em PNG: vira JPEG (bem menor, lido por tudo)
    const opaquePng = meta.format === 'png' && (!meta.hasAlpha || (await sharp(buffer, { failOn: 'none' }).stats()).isOpaque);
    if (opaquePng) {
      out = await sized.flatten({ background: '#ffffff' }).jpeg({ quality: 76, mozjpeg: true, progressive: true }).toBuffer();
      outType = 'image/jpeg';
    } else if (meta.format === 'png') {
      out = await sized.png({ compressionLevel: 9, adaptiveFiltering: true, effort: 8 }).toBuffer();
      outType = 'image/png';
    } else if (meta.format === 'webp') {
      out = await sized.webp({ quality: 80, effort: 5 }).toBuffer();
      outType = 'image/webp';
    } else if (meta.format === 'jpeg') {
      out = await sized.jpeg({ quality: 76, mozjpeg: true, progressive: true }).toBuffer();
      outType = 'image/jpeg';
    } else {
      return keep(buffer, mimetype);
    }

    return out.length < buffer.length ? { buffer: out, mimetype: outType, changed: true } : keep(buffer, mimetype);
  } catch {
    // arquivo estranho ou corrompido: sobe como veio, a validação de tipo já passou
    return keep(buffer, mimetype);
  }
}
