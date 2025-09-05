import { Injectable } from '@nestjs/common';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import * as sharp from 'sharp';
import * as crypto from 'crypto';

interface ImageVariant {
  width: number;
  suffix: string;
  quality: number;
}

interface OptimizedImage {
  buffer: Buffer;
  key: string;
  width: number;
  suffix: string;
  size: number;
}

interface OptimizationResult {
  id: string;
  originalSize: number;
  optimizedSize: number;
  compressionRatio: number;
  blurPlaceholder: string;
  mainUrl: string;
  variants: {
    [key: string]: {
      url: string;
      width: number;
      size: number;
    };
  };
  srcSet: string;
  sizes: string;
}

@Injectable()
export class UploadOptimizationService {
  private s3: S3Client;
  private readonly bucketName: string;
  private readonly region: string;

  private readonly imageVariants: ImageVariant[] = [
    { width: 400, suffix: 'thumb', quality: 80 },
    { width: 800, suffix: 'medium', quality: 85 },
    { width: 1200, suffix: 'large', quality: 85 },
    { width: 1920, suffix: 'xlarge', quality: 90 },
  ];

  constructor() {
    this.s3 = new S3Client({
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
      region: process.env.AWS_REGION,
    });
    this.bucketName = process.env.AWS_S3_BUCKET;
    this.region = process.env.AWS_REGION;
  }

  async optimizeAndUploadImage(
    fileBuffer: Buffer,
    folder: string,
    fileName?: string,
  ): Promise<OptimizationResult> {
    try {
      const fileId = crypto.randomUUID();
      const originalBuffer = fileBuffer;

      // 1. Análise da imagem original
      const metadata = await sharp(originalBuffer).metadata();
      console.log('📸 Imagem original:', {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        size: `${(originalBuffer.length / 1024 / 1024).toFixed(2)}MB`,
      });

      // 2. Geração de múltiplos tamanhos otimizados
      const processedImages = await this.processMultipleVariants(
        originalBuffer,
        fileId,
        folder,
      );

      // 3. Geração de placeholder blur (Base64)
      const blurPlaceholder =
        await this.generateBlurPlaceholder(originalBuffer);

      // 4. Upload paralelo para S3
      const uploadedImages = await this.uploadImagesToS3(processedImages);

      // 5. Métricas de otimização
      const totalOriginalSize = originalBuffer.length;
      const totalOptimizedSize = uploadedImages.reduce(
        (sum, img) => sum + img.size,
        0,
      );
      const compressionRatio = Number(
        ((1 - totalOptimizedSize / totalOriginalSize) * 100).toFixed(1),
      );

      console.log(`🎯 Compressão: ${compressionRatio}% de redução`);
      console.log(
        `📦 Original: ${(totalOriginalSize / 1024 / 1024).toFixed(2)}MB`,
      );
      console.log(
        `📦 Otimizado: ${(totalOptimizedSize / 1024 / 1024).toFixed(2)}MB`,
      );

      // 6. Preparar resultado estruturado
      const variants = uploadedImages.reduce((acc, img) => {
        acc[img.suffix] = {
          url: img.url,
          width: img.width,
          size: img.size,
        };
        return acc;
      }, {});

      // URL principal será a versão 'large'
      const mainUrl = variants['large']?.url || uploadedImages[0].url;

      return {
        id: fileId,
        originalSize: totalOriginalSize,
        optimizedSize: totalOptimizedSize,
        compressionRatio,
        blurPlaceholder,
        mainUrl,
        variants,
        srcSet: uploadedImages
          .map((img) => `${img.url} ${img.width}w`)
          .join(', '),
        sizes: '(max-width: 768px) 400px, (max-width: 1024px) 800px, 1200px',
      };
    } catch (error) {
      console.error('❌ Erro na otimização:', error);
      throw new Error(`Falha na otimização da imagem: ${error.message}`);
    }
  }

  private async processMultipleVariants(
    originalBuffer: Buffer,
    fileId: string,
    folder: string,
  ): Promise<OptimizedImage[]> {
    const processPromises = this.imageVariants.map(async (variant) => {
      try {
        const processedBuffer = await sharp(originalBuffer)
          .resize(variant.width, null, {
            fit: 'inside',
            withoutEnlargement: true,
            kernel: sharp.kernel.lanczos3,
          })
          .webp({
            quality: variant.quality,
            effort: 6,
            smartSubsample: false,
            nearLossless: variant.suffix === 'xlarge',
          })
          .toBuffer();

        return {
          buffer: processedBuffer,
          key: `${folder}/${fileId}-${variant.suffix}.webp`,
          width: variant.width,
          suffix: variant.suffix,
          size: processedBuffer.length,
        };
      } catch (error) {
        console.error(`Erro ao processar variante ${variant.suffix}:`, error);
        throw error;
      }
    });

    return Promise.all(processPromises);
  }

  private async generateBlurPlaceholder(
    originalBuffer: Buffer,
  ): Promise<string> {
    try {
      const blurBuffer = await sharp(originalBuffer)
        .resize(20, null)
        .blur(2)
        .webp({ quality: 20 })
        .toBuffer();

      return `data:image/webp;base64,${blurBuffer.toString('base64')}`;
    } catch (error) {
      console.error('Erro ao gerar placeholder blur:', error);
      return '';
    }
  }

  private async uploadImagesToS3(
    images: OptimizedImage[],
  ): Promise<Array<OptimizedImage & { url: string }>> {
    const uploadPromises = images.map(async (img) => {
      try {
        const upload = new Upload({
          client: this.s3,
          params: {
            Bucket: this.bucketName,
            Key: img.key,
            Body: img.buffer,
            ContentType: 'image/webp',
            CacheControl: 'public, max-age=31536000, immutable',
            Metadata: {
              originalSize: img.size.toString(),
              width: img.width.toString(),
            },
          },
        });

        await upload.done();

        // Construir URL manualmente
        const url = `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${img.key}`;

        return {
          ...img,
          url,
        };
      } catch (error) {
        console.error(`Erro ao fazer upload da variante ${img.suffix}:`, error);
        throw error;
      }
    });

    return Promise.all(uploadPromises);
  }

  // Método para compatibilidade com multer-s3
  createMulterS3CompatibleResponse(result: OptimizationResult): any {
    // Retorna um objeto compatível com Express.MulterS3.File
    return {
      fieldname: 'image',
      originalname: 'optimized-image.webp',
      encoding: '7bit',
      mimetype: 'image/webp',
      size: result.optimizedSize,
      bucket: this.bucketName,
      key: result.mainUrl.split('.amazonaws.com/')[1],
      acl: undefined,
      contentType: 'image/webp',
      contentDisposition: undefined,
      contentEncoding: undefined,
      storageClass: undefined,
      serverSideEncryption: undefined,
      metadata: {
        fieldName: 'image',
        variants: JSON.stringify(result.variants),
      },
      location: result.mainUrl,
      etag: undefined,
      versionId: undefined,
    };
  }
}
