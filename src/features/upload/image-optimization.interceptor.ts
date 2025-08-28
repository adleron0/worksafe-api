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
    const file = request.file;

    // Se não há arquivo ou se já foi processado, continua normalmente
    if (!file || file.location) {
      return next.handle();
    }

    // Se é um arquivo em memória (buffer), processa com otimização
    if (file.buffer) {
      try {
        console.log('🔄 Iniciando otimização da imagem...');
        
        // Extrai o folder do fieldname ou usa padrão
        const folder = request.body.folder || 'images';
        
        // Otimiza e faz upload da imagem
        const optimizationResult = await this.uploadOptimizationService.optimizeAndUploadImage(
          file.buffer,
          folder,
          file.originalname,
        );

        // Converte resultado para formato compatível com MulterS3
        const compatibleFile = this.uploadOptimizationService.createMulterS3CompatibleResponse(
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
        console.error('❌ Erro na otimização, continuando sem otimizar:', error);
        // Em caso de erro, continua sem otimização
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