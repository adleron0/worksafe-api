// upload.middleware.ts
import * as multerS3 from 'multer-s3';
import * as multer from 'multer';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { compressImage } from './image-compress';
import { Request as ExpressRequest } from 'express';
import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';

const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  region: process.env.AWS_REGION,
});

if (!process.env.AWS_S3_BUCKET) {
  throw new Error('A variável de ambiente AWS_S3_BUCKET é obrigatória');
}

/** Nome do arquivo seguro para chave do S3: sem acento, espaço ou símbolo. */
export const safeFileName = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'arquivo';

/**
 * Storage do multer que comprime a foto (ver image-compress.ts) antes de gravar
 * no S3. Devolve o mesmo formato do multer-s3 (`location`, `key`…), então
 * hooks e controllers continuam iguais.
 */
class CompressedS3Storage implements multer.StorageEngine {
  constructor(private readonly folder: string) {}

  _handleFile(req: ExpressRequest, file: Express.Multer.File, cb: (error?: unknown, info?: Partial<Express.MulterS3.File>) => void) {
    const chunks: Buffer[] = [];
    file.stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    file.stream.on('error', cb);
    file.stream.on('end', async () => {
      try {
        const original = Buffer.concat(chunks);
        const { buffer, mimetype } = await compressImage(original, file.mimetype);
        let name = safeFileName(String(req.body?.name || file.originalname));
        // PNG opaco que virou JPEG: a extensão acompanha o formato novo
        if (mimetype === 'image/jpeg' && file.mimetype !== mimetype) name = name.replace(/\.png$/i, '') + '.jpg';
        const key = `${this.folder}/${Date.now()}_${name}`;
        const bucket = process.env.AWS_S3_BUCKET as string;
        const result = await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buffer,
          ContentType: mimetype,
          // chave única por envio (timestamp): pode ficar em cache por 1 ano
          CacheControl: 'public, max-age=31536000, immutable',
        }));
        cb(null, {
          bucket,
          key,
          location: `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`,
          contentType: mimetype,
          mimetype,
          size: buffer.length,
          etag: result.ETag ?? '',
        });
      } catch (error) {
        cb(error);
      }
    });
  }

  _removeFile(_req: ExpressRequest, file: Partial<Express.MulterS3.File>, cb: (error: Error | null) => void) {
    if (!file.key) return cb(null);
    s3.send(new DeleteObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: file.key }))
      .then(() => cb(null))
      .catch((error) => cb(error));
  }
}

export const getMulterOptions = (folder: string) => ({
  storage: new CompressedS3Storage(folder),
  limits: {
    fileSize: 20 * 1024 * 1024, // Limite de 20MB por arquivo
  },
  fileFilter: (_req, file, cb) => {
    // Apenas processa arquivos de imagem
    if (file && file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(null, false); // Ignora o arquivo se não for imagem
    }
  },
});

// Nova função para usar com otimização
export const getOptimizedMulterOptions = (folder?: string) => ({
  storage: multer.memoryStorage(), // Armazena em memória para processar
  limits: {
    fileSize: 20 * 1024 * 1024, // Limite de 20MB por arquivo
  },
  fileFilter: (_req, file, cb) => {
    // Apenas processa arquivos de imagem
    if (file && file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Apenas imagens são permitidas'), false);
    }
  },
});

const DOCUMENT_MIME = new Set(['application/pdf', 'application/xml', 'text/xml']);

/**
 * Documentos (PDF/XML/imagem) — ex.: nota fiscal anexada ao recebível.
 * A chave leva um UUID: a URL do bucket é pública, então o nome não pode ser
 * adivinhável a partir do número da nota ou da data.
 */
export const getDocumentMulterOptions = (folder: string) => ({
  storage: multerS3({
    s3,
    bucket: process.env.AWS_S3_BUCKET,
    key: (_req: ExpressRequest, file, cb) => {
      const ext = (file.originalname.match(/\.[a-zA-Z0-9]{1,5}$/)?.[0] ?? '').toLowerCase();
      cb(null, `${folder}/${randomUUID()}${ext}`);
    },
    contentType: multerS3.AUTO_CONTENT_TYPE,
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file && (DOCUMENT_MIME.has(file.mimetype) || file.mimetype.startsWith('image/'));
    if (ok) cb(null, true);
    else cb(new BadRequestException('Arquivo da nota deve ser PDF, XML ou imagem'), false);
  },
});
