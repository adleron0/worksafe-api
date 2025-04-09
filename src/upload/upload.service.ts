import { Injectable } from '@nestjs/common';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';

@Injectable()
export class UploadService {
  private s3: S3Client;

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

    const bucketParams = {
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key,
    };

    try {
      const data = await this.s3.send(new DeleteObjectCommand(bucketParams));
      console.log('Sucesso: Objeto deletado do S3.', data);
    } catch (err) {
      console.error('Erro ao deletar objeto do S3:', err);
      throw new Error('Falha ao excluir a imagem do S3');
    }
  }
}
