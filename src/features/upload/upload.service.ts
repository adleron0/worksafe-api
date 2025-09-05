import { Injectable } from '@nestjs/common';
import {
  S3Client,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

@Injectable()
export class UploadService {
  private s3: S3Client;
  private readonly imageVariantSuffixes = [
    'thumb',
    'medium',
    'large',
    'xlarge',
  ];

  constructor() {
    this.s3 = new S3Client({
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
      region: process.env.AWS_REGION,
    });
  }

  async deleteImageFromS3(imageUrl: string): Promise<void> {
    // Extrai a chave completa da URL do S3
    const key = imageUrl.split('.amazonaws.com/')[1];
    if (!key) {
      console.error(
        'Erro: Não foi possível extrair a chave completa da URL da imagem.',
      );
      return;
    }

    // Verifica se é uma imagem otimizada (contém sufixo -large, -medium, etc)
    const isOptimizedImage = this.imageVariantSuffixes.some((suffix) =>
      key.includes(`-${suffix}.`),
    );

    if (isOptimizedImage) {
      // Deleta todas as variantes
      await this.deleteAllImageVariants(key);
    } else {
      // Deleta apenas a imagem única (compatibilidade com imagens antigas)
      await this.deleteSingleImage(key);
    }
  }

  private async deleteSingleImage(key: string): Promise<void> {
    const bucketParams = {
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key,
    };

    try {
      const data = await this.s3.send(new DeleteObjectCommand(bucketParams));
      console.log('✅ Imagem deletada do S3:', key);
    } catch (err) {
      console.error('Erro ao deletar objeto do S3:', err);
      throw new Error('Falha ao excluir a imagem do S3');
    }
  }

  private async deleteAllImageVariants(key: string): Promise<void> {
    try {
      // Extrai o ID base da imagem removendo o sufixo de tamanho
      // Ex: "images/abc123-large.webp" → "images/abc123"
      let baseKey = key;
      for (const suffix of this.imageVariantSuffixes) {
        if (key.includes(`-${suffix}.`)) {
          baseKey = key.substring(0, key.indexOf(`-${suffix}.`));
          break;
        }
      }

      // Cria promessas para deletar todas as variantes
      const deletePromises = this.imageVariantSuffixes.map(async (suffix) => {
        const variantKey = `${baseKey}-${suffix}.webp`;

        try {
          await this.s3.send(
            new DeleteObjectCommand({
              Bucket: process.env.AWS_S3_BUCKET,
              Key: variantKey,
            }),
          );
          console.log(`✅ Variante deletada: ${variantKey}`);
        } catch (err) {
          // Ignora erro se a variante não existir
          console.log(
            `⚠️ Variante não encontrada ou já deletada: ${variantKey}`,
          );
        }
      });

      // Executa todas as deleções em paralelo
      await Promise.all(deletePromises);
      console.log('✅ Todas as variantes da imagem foram deletadas');
    } catch (error) {
      console.error('Erro ao deletar variantes da imagem:', error);
      throw new Error('Falha ao excluir as variantes da imagem do S3');
    }
  }

  // Método alternativo: Listar e deletar por prefixo
  async deleteImagesByPrefix(imageUrl: string): Promise<void> {
    const key = imageUrl.split('.amazonaws.com/')[1];
    if (!key) return;

    // Extrai o prefixo (sem o sufixo de tamanho)
    const prefix = key.substring(0, key.lastIndexOf('-'));

    try {
      // Lista todos os objetos com esse prefixo
      const listCommand = new ListObjectsV2Command({
        Bucket: process.env.AWS_S3_BUCKET,
        Prefix: prefix,
      });

      const { Contents } = await this.s3.send(listCommand);

      if (!Contents || Contents.length === 0) {
        console.log('Nenhuma imagem encontrada com o prefixo:', prefix);
        return;
      }

      // Deleta todos os objetos encontrados
      const deletePromises = Contents.map(({ Key }) =>
        this.s3.send(
          new DeleteObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET,
            Key,
          }),
        ),
      );

      await Promise.all(deletePromises);
      console.log(
        `✅ ${Contents.length} imagens deletadas com prefixo: ${prefix}`,
      );
    } catch (error) {
      console.error('Erro ao deletar imagens por prefixo:', error);
      throw error;
    }
  }
}
