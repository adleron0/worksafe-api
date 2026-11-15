import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Armazenamento privado: documentos de funcionário (RH) e arquivos da empresa.
 *
 * O bucket não tem leitura pública e não existe link direto: quem grava e quem
 * lê é sempre a API, depois de conferir a permissão. O banco guarda só a chave.
 * `PRIVATE_STORAGE_DRIVER=memory` troca o S3 pela memória (testes e uso local).
 */
@Injectable()
export class PrivateStorageService {
  private readonly memory = new Map<string, { body: Buffer; contentType: string }>();
  private client: S3Client | null = null;

  private get inMemory() { return process.env.PRIVATE_STORAGE_DRIVER === 'memory'; }

  private bucket(): string {
    const bucket = process.env.AWS_S3_PRIVATE_BUCKET;
    if (!bucket) throw new ServiceUnavailableException('O armazenamento privado de documentos ainda não foi configurado');
    return bucket;
  }

  private s3(): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        region: process.env.AWS_S3_PRIVATE_REGION || process.env.AWS_REGION,
        credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
      });
    }
    return this.client;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    if (this.inMemory) { this.memory.set(key, { body, contentType }); return; }
    await this.s3().send(new PutObjectCommand({ Bucket: this.bucket(), Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }));
  }

  async get(key: string): Promise<Buffer> {
    if (this.inMemory) {
      const found = this.memory.get(key);
      if (!found) throw new NotFoundException('Arquivo não encontrado no armazenamento');
      return found.body;
    }
    try {
      const result = await this.s3().send(new GetObjectCommand({ Bucket: this.bucket(), Key: key }));
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if ((error as { name?: string })?.name === 'NoSuchKey') throw new NotFoundException('Arquivo não encontrado no armazenamento');
      throw error;
    }
  }

  /** Apaga de verdade (lixeira vencida ou "apagar agora"). Chave que já não existe não é erro. */
  async delete(key: string): Promise<void> {
    if (this.inMemory) { this.memory.delete(key); return; }
    await this.s3().send(new DeleteObjectCommand({ Bucket: this.bucket(), Key: key }));
  }
}
