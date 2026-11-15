import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
        // sem isto o SDK põe no link de envio a soma de verificação de um corpo vazio, que não é o que o navegador vai mandar
        requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
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

  // ------------------------------------------------------------------ arquivos grandes
  //
  // Arquivo grande não passa pela memória da API: o navegador envia direto ao
  // armazenamento, em partes, e baixa por um link que vale poucos minutos. A API
  // só confere a permissão e assina cada passo. No modo memória (testes) os
  // links são do esquema "memory:" e as partes são entregues por `memoryPart`.

  private readonly memoryUploads = new Map<string, { key: string; contentType: string; parts: Map<number, Buffer> }>();

  /** Link temporário para ver ou baixar direto do armazenamento. Quem tiver o link baixa sem login enquanto ele valer. */
  async linkTo(key: string, options: { fileName: string; contentType: string; inline: boolean; seconds: number }): Promise<string> {
    if (this.inMemory) {
      if (!this.memory.has(key)) throw new NotFoundException('Arquivo não encontrado no armazenamento');
      return `memory://${key}?expires=${options.seconds}&disposition=${options.inline ? 'inline' : 'attachment'}`;
    }
    const disposition = `${options.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(options.fileName)}`;
    return getSignedUrl(this.s3(), new GetObjectCommand({ Bucket: this.bucket(), Key: key, ResponseContentDisposition: disposition, ResponseContentType: options.contentType }), { expiresIn: options.seconds });
  }

  /** Abre um envio em partes e devolve o identificador dele. */
  async startUpload(key: string, contentType: string): Promise<string> {
    if (this.inMemory) {
      const uploadId = `mem-${this.memoryUploads.size + 1}-${Date.now()}`;
      this.memoryUploads.set(uploadId, { key, contentType, parts: new Map() });
      return uploadId;
    }
    const result = await this.s3().send(new CreateMultipartUploadCommand({ Bucket: this.bucket(), Key: key, ContentType: contentType, ServerSideEncryption: 'AES256' }));
    if (!result.UploadId) throw new ServiceUnavailableException('O armazenamento não abriu o envio');
    return result.UploadId;
  }

  /** O endereço para o navegador enviar uma parte (PUT), válido por `seconds`. */
  async partLink(key: string, uploadId: string, partNumber: number, seconds: number): Promise<string> {
    if (this.inMemory) return `memory://${key}?uploadId=${uploadId}&partNumber=${partNumber}`;
    return getSignedUrl(this.s3(), new UploadPartCommand({ Bucket: this.bucket(), Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: seconds });
  }

  /** Só nos testes: faz o papel do navegador entregando uma parte. Devolve a etiqueta (ETag) da parte. */
  memoryPart(uploadId: string, partNumber: number, body: Buffer): string {
    const upload = this.memoryUploads.get(uploadId);
    if (!upload) throw new NotFoundException('Envio não encontrado');
    upload.parts.set(partNumber, body);
    return `"mem-${partNumber}-${body.length}"`;
  }

  /** Junta as partes e fecha o envio. Devolve o tamanho final do arquivo. */
  async finishUpload(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<number> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    if (this.inMemory) {
      const upload = this.memoryUploads.get(uploadId);
      if (!upload) throw new NotFoundException('Envio não encontrado');
      const missing = ordered.find((part) => upload.parts.get(part.partNumber) === undefined || `"mem-${part.partNumber}-${upload.parts.get(part.partNumber)!.length}"` !== part.etag);
      if (missing) throw new NotFoundException(`A parte ${missing.partNumber} não chegou ao armazenamento`);
      const body = Buffer.concat(ordered.map((part) => upload.parts.get(part.partNumber)!));
      this.memory.set(key, { body, contentType: upload.contentType });
      this.memoryUploads.delete(uploadId);
      return body.length;
    }
    await this.s3().send(new CompleteMultipartUploadCommand({ Bucket: this.bucket(), Key: key, UploadId: uploadId, MultipartUpload: { Parts: ordered.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) } }));
    const head = await this.s3().send(new HeadObjectCommand({ Bucket: this.bucket(), Key: key }));
    return Number(head.ContentLength ?? 0);
  }

  /** Desiste de um envio em partes: o que já tinha chegado é descartado. Envio que já não existe não é erro. */
  async cancelUpload(key: string, uploadId: string): Promise<void> {
    if (this.inMemory) { this.memoryUploads.delete(uploadId); return; }
    try {
      await this.s3().send(new AbortMultipartUploadCommand({ Bucket: this.bucket(), Key: key, UploadId: uploadId }));
    } catch (error) {
      if ((error as { name?: string })?.name !== 'NoSuchUpload') throw error;
    }
  }
}
