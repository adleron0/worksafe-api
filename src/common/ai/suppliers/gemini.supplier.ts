import { Injectable } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import {
  IAISupplier,
  GenerateArticleParams,
  ReviewArticleParams,
  ReviewResult,
} from '../ai.interface';

/**
 * Supplier para Google Gemini, pelo SDK atual (@google/genai).
 * Chave: AI_API_KEY (ou GEMINI_API_KEY). Modelo: AI_MODEL_FAST.
 * Antes usava o pacote descontinuado @google/generative-ai por import
 * dinâmico com eval(), que nem estava instalado.
 */
@Injectable()
export class GeminiSupplier implements IAISupplier {
  private client: GoogleGenAI | null = null;

  private ensureConfigured(): GoogleGenAI {
    const key = process.env.AI_API_KEY || process.env.GEMINI_API_KEY || '';
    if (!key) throw new Error('Gemini não está configurado: defina AI_API_KEY ou GEMINI_API_KEY.');
    if (!this.client) this.client = new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: process.env.AI_GEMINI_API_VERSION || 'v1beta' } });
    return this.client;
  }

  async generateContent(prompt: string): Promise<string> {
    const result = await this.ensureConfigured().models.generateContent({
      model: process.env.AI_MODEL_FAST || 'gemini-3.8-flash',
      contents: prompt,
    });
    return result.text ?? '';
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
