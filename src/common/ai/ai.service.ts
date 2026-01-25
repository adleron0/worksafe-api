import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  IAISupplier,
  AISupplierType,
  GenerateArticleParams,
  ReviewArticleParams,
  ReviewResult,
} from './ai.interface';
import { GroqSupplier } from './suppliers/groq.supplier';
import { GeminiSupplier } from './suppliers/gemini.supplier';

@Injectable()
export class AIService implements OnModuleInit {
  private supplier: IAISupplier;
  private supplierType: AISupplierType;

  constructor(
    private readonly groqSupplier: GroqSupplier,
    private readonly geminiSupplier: GeminiSupplier,
  ) {}

  onModuleInit() {
    this.supplierType = (process.env.AI_USING as AISupplierType) || 'GROQ';
    this.supplier = this.getSupplier(this.supplierType);
    console.log(`🤖 AI Service inicializado com supplier: ${this.supplierType}`);
  }

  /**
   * Retorna o supplier configurado
   */
  private getSupplier(type: AISupplierType): IAISupplier {
    switch (type) {
      case 'GROQ':
        return this.groqSupplier;
      case 'GEMINI':
        return this.geminiSupplier;
      case 'OPENAI':
        // Pode ser implementado no futuro
        throw new Error('OpenAI supplier não implementado ainda');
      default:
        console.warn(`Supplier ${type} não reconhecido, usando GROQ`);
        return this.groqSupplier;
    }
  }

  /**
   * Retorna o nome do supplier ativo
   */
  getActiveSupplier(): string {
    return this.supplierType;
  }

  /**
   * Gera conteúdo livre baseado em um prompt
   */
  async generateContent(prompt: string): Promise<string> {
    return this.supplier.generateContent(prompt);
  }

  /**
   * Gera um artigo de blog completo
   */
  async generateArticle(params: GenerateArticleParams): Promise<string> {
    return this.supplier.generateArticle(params);
  }

  /**
   * Revisa e melhora um texto existente
   */
  async reviewAndImprove(params: ReviewArticleParams): Promise<ReviewResult> {
    return this.supplier.reviewAndImprove(params);
  }
}
