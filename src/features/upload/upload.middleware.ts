// upload.middleware.ts
import * as multerS3 from 'multer-s3';
import * as multer from 'multer';
import { S3Client } from '@aws-sdk/client-s3';
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

export const getMulterOptions = (folder: string) => ({
  storage: multerS3({
    s3,
    bucket: process.env.AWS_S3_BUCKET,
    key: (req: ExpressRequest, file, cb) => {
      const name = (req.body.name || file.originalname).replace(/\s+/g, '_');
      cb(null, `${folder}/${Date.now()}_${name}`);
    },
    contentType: multerS3.AUTO_CONTENT_TYPE,
  }),
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
