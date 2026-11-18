process.env.AWS_S3_BUCKET = 'bucket-teste';
process.env.AWS_REGION = 'us-east-1';

import { Readable } from 'stream';
import * as sharp from 'sharp';
import { S3Client } from '@aws-sdk/client-s3';
import { getMulterOptions, safeFileName } from './upload.middleware';

describe('getMulterOptions: upload comprimido para o S3', () => {
  const send = jest.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({ ETag: '"x"' }) as never);
  afterAll(() => send.mockRestore());

  it('nome do arquivo vira chave segura (sem acento nem espaço)', () => {
    expect(safeFileName('Manutenção Predial (nova).PNG')).toBe('Manutencao_Predial_nova_.PNG');
  });

  it('comprime, grava com tipo e cache e devolve location como o multer-s3', async () => {
    const raw = Buffer.alloc(1800 * 1200 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) % 251;
    const png = await sharp(raw, { raw: { width: 1800, height: 1200, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();

    const storage = getMulterOptions('services-image').storage as any;
    const info: any = await new Promise((resolve, reject) =>
      storage._handleFile(
        { body: { name: 'Limpeza de Silos.png' } },
        { stream: Readable.from([png]), mimetype: 'image/png', originalname: 'x.png' },
        (err: unknown, data: unknown) => (err ? reject(err) : resolve(data)),
      ),
    );

    const cmd = (send.mock.calls[0][0] as any).input;
    expect(cmd.Bucket).toBe('bucket-teste');
    expect(cmd.ContentType).toBe('image/jpeg');
    expect(cmd.CacheControl).toContain('max-age=31536000');
    expect(cmd.Body.length).toBeLessThan(png.length);
    expect(info.key).toMatch(/^services-image\/\d+_Limpeza_de_Silos\.jpg$/);
    expect(info.location).toBe(`https://bucket-teste.s3.us-east-1.amazonaws.com/${info.key}`);
    expect(info.size).toBe(cmd.Body.length);
  });
});
