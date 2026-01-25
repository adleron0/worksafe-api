import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import {
  IAISupplier,
  GenerateArticleParams,
  ReviewArticleParams,
  ReviewResult,
} from '../ai.interface';

@Injectable()
export class GroqSupplier implements IAISupplier {
  private client: OpenAI;
  private model = 'llama-3.3-70b-versatile';

  constructor() {
    this.client = new OpenAI({
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: process.env.AI_API_KEY,
    });
  }

  async generateContent(prompt: string): Promise<string> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 4096,
    });

    return completion.choices[0]?.message?.content || '';
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
2. Use tags HTML para formatação (NÃO use Markdown)
3. Use <h2> para títulos de seção
4. Use <h3> para subtítulos
5. Use <p> para parágrafos (adicione class="ql-align-justify" para texto justificado)
6. Use <strong> para negrito e <em> para itálico
7. Use <ul> e <li> para listas
8. Inclua informações relevantes e atualizadas sobre o tema
9. Mantenha o tom ${tone} ao longo do texto
10. Se aplicável, inclua dicas práticas ou exemplos
11. Finalize com uma conclusão que resuma os pontos principais
12. O artigo deve ser original e informativo

**Exemplo de formato esperado:**
<h2>Introdução</h2><p class="ql-align-justify">Texto do parágrafo aqui com <strong>palavras em negrito</strong> quando necessário.</p><h2>Seção Principal</h2><p class="ql-align-justify">Mais conteúdo...</p>

**IMPORTANTE:**
- Retorne APENAS o conteúdo HTML do artigo
- NÃO inclua tags <html>, <head>, <body>
- NÃO inclua comentários ou explicações
- NÃO use Markdown, apenas HTML`;

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

**Texto original (em HTML):**
${content}

**Sua tarefa:**
1. Corrija erros gramaticais e ortográficos
2. Melhore a clareza e fluidez do texto
3. Aprimore a estrutura e organização
4. Mantenha o tom e estilo original
5. Adicione ou melhore subtítulos se necessário
6. MANTENHA o formato HTML do texto (tags <h2>, <h3>, <p>, <strong>, etc.)
7. Use class="ql-align-justify" nos parágrafos <p>
${includeReferences ? '8. Sugira referências ou fontes relevantes para o tema (sites, artigos, normas, etc.)' : ''}

**Retorne EXATAMENTE no seguinte formato JSON:**
{
  "improvedContent": "O texto completo revisado e melhorado em HTML (mesmo formato do original)",
  "corrections": ["Lista de correções feitas"],
  "suggestions": ["Lista de sugestões de melhoria"],
  "references": ["Lista de referências sugeridas (URLs ou títulos de fontes)"]
}

**IMPORTANTE:**
- Retorne APENAS o JSON válido, sem markdown code blocks ou texto adicional
- O improvedContent deve estar em HTML, NÃO em Markdown`;

    const response = await this.generateContent(prompt);

    try {
      // Tenta fazer parse do JSON
      // Remove possíveis code blocks markdown
      const cleanResponse = response
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      const parsed = JSON.parse(cleanResponse);
      return {
        improvedContent: parsed.improvedContent || content,
        corrections: parsed.corrections || [],
        suggestions: parsed.suggestions || [],
        references: parsed.references || [],
      };
    } catch (error) {
      // Se falhar o parse, retorna o texto como está
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
