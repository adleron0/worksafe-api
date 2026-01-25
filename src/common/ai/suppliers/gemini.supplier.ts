import { Injectable } from '@nestjs/common';
import {
  IAISupplier,
  GenerateArticleParams,
  ReviewArticleParams,
  ReviewResult,
} from '../ai.interface';

/**
 * Supplier para Google Gemini
 * Para usar, instale: npm install @google/generative-ai
 * E configure: AI_API_KEY com sua chave do Google AI Studio
 */
@Injectable()
export class GeminiSupplier implements IAISupplier {
  private model: any = null;
  private isConfigured = false;
  private initPromise: Promise<void> | null = null;

  constructor() {
    // Não inicializa automaticamente para evitar erro de import
  }

  private async initializeClient() {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // Dynamic import para não quebrar se o pacote não estiver instalado
        const module = await (eval('import("@google/generative-ai")') as Promise<any>);
        const { GoogleGenerativeAI } = module;
        const genAI = new GoogleGenerativeAI(process.env.AI_API_KEY || '');
        this.model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        this.isConfigured = true;
      } catch (error) {
        console.warn(
          'Gemini não configurado. Instale @google/generative-ai para usar.',
        );
        this.isConfigured = false;
      }
    })();

    return this.initPromise;
  }

  private async ensureConfigured() {
    await this.initializeClient();
    if (!this.isConfigured) {
      throw new Error(
        'Gemini não está configurado. Instale @google/generative-ai e configure AI_API_KEY.',
      );
    }
  }

  async generateContent(prompt: string): Promise<string> {
    await this.ensureConfigured();

    const result = await this.model.generateContent(prompt);
    return result.response.text();
  }

  async generateArticle(params: GenerateArticleParams): Promise<string> {
    const {
      title,
      summary,
      category,
      language = 'português brasileiro',
      tone = 'formal',
      minWords = 800,
    } = params;

    const prompt = `Você é um redator profissional especializado em criar artigos de blog de alta qualidade.

Crie um artigo completo seguindo estas especificações:

**Título:** ${title}
**Resumo/Tema:** ${summary}
**Categoria:** ${category}
**Idioma:** ${language}
**Tom:** ${tone}
**Mínimo de palavras:** ${minWords}

**Instruções:**
1. Escreva um artigo bem estruturado com introdução, desenvolvimento e conclusão
2. Use subtítulos (##) para organizar as seções
3. Inclua informações relevantes e atualizadas sobre o tema
4. Mantenha o tom ${tone} ao longo do texto
5. Se aplicável, inclua dicas práticas ou exemplos
6. Finalize com uma conclusão que resuma os pontos principais
7. O artigo deve ser original e informativo
8. Formate o texto em Markdown

**IMPORTANTE:** Retorne APENAS o conteúdo do artigo em Markdown, sem comentários adicionais.`;

    return this.generateContent(prompt);
  }

  async reviewAndImprove(params: ReviewArticleParams): Promise<ReviewResult> {
    const {
      content,
      title = '',
      category = '',
      includeReferences = true,
    } = params;

    const prompt = `Você é um editor profissional e revisor de textos.

Analise e melhore o seguinte artigo:

${title ? `**Título:** ${title}` : ''}
${category ? `**Categoria:** ${category}` : ''}

**Texto original:**
${content}

**Sua tarefa:**
1. Corrija erros gramaticais e ortográficos
2. Melhore a clareza e fluidez do texto
3. Aprimore a estrutura e organização
4. Mantenha o tom e estilo original
5. Adicione ou melhore subtítulos se necessário
${includeReferences ? '6. Sugira referências ou fontes relevantes para o tema (sites, artigos, normas, etc.)' : ''}

**Retorne EXATAMENTE no seguinte formato JSON:**
{
  "improvedContent": "O texto completo revisado e melhorado em Markdown",
  "corrections": ["Lista de correções feitas"],
  "suggestions": ["Lista de sugestões de melhoria"],
  "references": ["Lista de referências sugeridas (URLs ou títulos de fontes)"]
}

**IMPORTANTE:** Retorne APENAS o JSON válido, sem markdown code blocks ou texto adicional.`;

    const response = await this.generateContent(prompt);

    try {
      const parsed = JSON.parse(response.trim());
      return {
        improvedContent: parsed.improvedContent || content,
        corrections: parsed.corrections || [],
        suggestions: parsed.suggestions || [],
        references: parsed.references || [],
      };
    } catch (error) {
      console.error('Erro ao parsear resposta da IA:', error);
      return {
        improvedContent: response,
        corrections: [],
        suggestions: ['Não foi possível extrair sugestões estruturadas'],
        references: [],
      };
    }
  }
}
