// upload.middleware.ts
import * as multerS3 from 'multer-s3';
import { S3Client } from '@aws-sdk/client-s3';
import { Request as ExpressRequest } from 'express';

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
