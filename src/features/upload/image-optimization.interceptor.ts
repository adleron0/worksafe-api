import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { UploadOptimizationService } from './upload-optimization.service';

@Injectable()
export class ImageOptimizationInterceptor implements NestInterceptor {
  constructor(
    private readonly uploadOptimizationService: UploadOptimizationService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const singleFile = request.file;
    const multipleFiles = request.files;

    // Processa arquivo único
    if (singleFile && !singleFile.location && singleFile.buffer) {
      try {
        console.log('🔄 Iniciando otimização da imagem...');

        // Extrai o folder do fieldname ou usa padrão
        const folder = request.body.folder || 'images';

        // Otimiza e faz upload da imagem
        const optimizationResult =
          await this.uploadOptimizationService.optimizeAndUploadImage(
            singleFile.buffer,
            folder,
            singleFile.originalname,
          );

        // Converte resultado para formato compatível com MulterS3
        const compatibleFile =
          this.uploadOptimizationService.createMulterS3CompatibleResponse(
            optimizationResult,
          );

        // Substitui o arquivo na request com versão compatível
        request.file = compatibleFile;

        // Adiciona informações extras na request para uso posterior
        request.imageOptimization = {
          variants: optimizationResult.variants,
          srcSet: optimizationResult.srcSet,
          sizes: optimizationResult.sizes,
          blurPlaceholder: optimizationResult.blurPlaceholder,
          compressionRatio: optimizationResult.compressionRatio,
        };

        console.log(
          `✅ Otimização concluída: ${optimizationResult.compressionRatio}% de compressão`,
        );
      } catch (error) {
        console.error(
          '❌ Erro na otimização, continuando sem otimizar:',
          error,
        );
        // Em caso de erro, continua sem otimização
      }
    }

    // Processa múltiplos arquivos
    if (multipleFiles && typeof multipleFiles === 'object') {
      const optimizationResults = {};
      
      for (const [fieldName, fileArray] of Object.entries(multipleFiles)) {
        if (Array.isArray(fileArray) && fileArray[0]) {
          const file = fileArray[0];
          
          if (!file.location && file.buffer) {
            try {
              console.log(`🔄 Iniciando otimização da imagem ${fieldName}...`);

              // Extrai o folder do fieldname ou usa padrão
              const folder = request.body.folder || 'images';

              // Otimiza e faz upload da imagem
              const optimizationResult =
                await this.uploadOptimizationService.optimizeAndUploadImage(
                  file.buffer,
                  folder,
                  file.originalname,
                );

              // Converte resultado para formato compatível com MulterS3
              const compatibleFile =
                this.uploadOptimizationService.createMulterS3CompatibleResponse(
                  optimizationResult,
                );

              // Substitui o arquivo no array com versão compatível
              multipleFiles[fieldName][0] = compatibleFile;

              // Adiciona informações de otimização
              optimizationResults[fieldName] = {
                variants: optimizationResult.variants,
                srcSet: optimizationResult.srcSet,
                sizes: optimizationResult.sizes,
                blurPlaceholder: optimizationResult.blurPlaceholder,
                compressionRatio: optimizationResult.compressionRatio,
              };

              console.log(
                `✅ Otimização de ${fieldName} concluída: ${optimizationResult.compressionRatio}% de compressão`,
              );
            } catch (error) {
              console.error(
                `❌ Erro na otimização de ${fieldName}, continuando sem otimizar:`,
                error,
              );
              // Em caso de erro, continua sem otimização
            }
          }
        }
      }
      
      // Se houve otimizações, adiciona na request
      if (Object.keys(optimizationResults).length > 0) {
        request.imageOptimization = optimizationResults;
      }
    }

    return next.handle().pipe(
      map((data) => {
        // Se houver dados de otimização, adiciona na resposta
        if (request.imageOptimization && data) {
          return {
            ...data,
            optimization: request.imageOptimization,
          };
        }
        return data;
      }),
    );
  }
}
