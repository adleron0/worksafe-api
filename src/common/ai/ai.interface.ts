/**
 * Interface para suppliers de IA
 * Todas as implementações devem seguir este contrato
 */
export interface IAISupplier {
  /**
   * Gera conteúdo baseado em um prompt
   */
  generateContent(prompt: string): Promise<string>;

  /**
   * Gera um artigo de blog completo
   */
  generateArticle(params: GenerateArticleParams): Promise<string>;

  /**
   * Revisa e melhora um texto existente
   */
  reviewAndImprove(params: ReviewArticleParams): Promise<ReviewResult>;
}

export interface GenerateArticleParams {
  title: string;
  summary: string;
  category: string;
  language?: string;
  tone?: 'formal' | 'informal' | 'technical';
  minWords?: number;
}

export interface ReviewArticleParams {
  content: string;
  title?: string;
  category?: string;
  includeReferences?: boolean;
}

export interface ReviewResult {
  improvedContent: string;
  corrections: string[];
  suggestions: string[];
  references?: string[];
}

export type AISupplierType = 'GROQ' | 'GEMINI' | 'OPENAI';
