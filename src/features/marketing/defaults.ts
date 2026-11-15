/**
 * Modelos de legenda que toda empresa recebe na primeira vez que abre a
 * divulgação. Seguem a estrutura dos posts de turma do Instagram da WorkSafe
 * (gancho em caixa alta, dados da turma, incluso, contato, hashtags), com a
 * gramática corrigida.
 *
 * Regras do texto (resolvidas no navegador):
 *  - `{{variavel}}` é trocada pelo valor;
 *  - linha com alguma variável vazia some inteira;
 *  - `{{#variavel}} … {{/variavel}}` só aparece se a variável tiver valor;
 *    `{{^variavel}} … {{/variavel}}` só aparece se estiver vazia.
 */
export const CAPTION_KINDS = ['turma_nova', 'ultimas_vagas', 'promocao', 'curso_rapido', 'story', 'outro'];

export const DEFAULT_CAPTIONS: { name: string; kind: string; body: string }[] = [
  {
    name: 'Turma nova',
    kind: 'turma_nova',
    body: `🚨 ABERTAS AS VAGAS PARA A PRÓXIMA TURMA DE {{curso_maiusculo}} 🚨
{{niveis_frase}}

🗓️ Datas: {{datas}}
⏰ Horário: {{horario}}
📚 Carga horária: {{carga_horaria}}
📍 Local: {{local}}
{{#precos_niveis}}

💰 Investimento:
{{precos_niveis}}
{{/precos_niveis}}
{{^precos_niveis}}

💰 Investimento: {{preco}}
{{/precos_niveis}}
{{#incluso_lista}}

INCLUSO:
{{incluso_lista}}
{{/incluso_lista}}

Para mais informações e reservas:
📲 WhatsApp: {{whatsapp}}
✉️ {{email}}
🔗 Inscrições: {{link_inscricao}}

{{hashtags}}`,
  },
  {
    name: 'Últimas vagas',
    kind: 'ultimas_vagas',
    body: `📌 ÚLTIMAS VAGAS PARA A TURMA DE {{curso_maiusculo}}!
{{vagas_frase}}

🗓️ {{datas}}
⏰ {{horario}}
📍 {{local}}
💰 {{preco}}
{{#incluso_lista}}

INCLUSO:
{{incluso_lista}}
{{/incluso_lista}}

Garanta a sua antes que acabe:
📲 {{whatsapp}}
🔗 {{link_inscricao}}

{{hashtags}}`,
  },
  {
    name: 'Promoção',
    kind: 'promocao',
    body: `🔥 VALOR PROMOCIONAL NA TURMA DE {{curso_maiusculo}} 🔥

De {{preco_de}} por apenas {{preco}}*
{{#parcelas}}Ou em até {{parcelas}}.
{{/parcelas}}

🗓️ Datas: {{datas}}
⏰ Horário: {{horario}}
📍 Local: {{local}}
{{#incluso_lista}}

INCLUSO:
{{incluso_lista}}
{{/incluso_lista}}

*Valor promocional por tempo limitado.

Para mais informações e reservas:
📲 {{whatsapp}}
✉️ {{email}}

{{hashtags}}`,
  },
  {
    name: 'Curso rápido',
    kind: 'curso_rapido',
    body: `📌 PARTICIPE DA NOSSA PRÓXIMA TURMA DE {{curso_maiusculo}} ‼️

🗓️ {{datas}}, {{horario}}.
📚 Certificado com carga horária de {{carga_horaria}}.

GARANTA SUA VAGA POR APENAS {{preco}}!

Inscrições:
📲 {{whatsapp}}
✉️ {{email}}

NÃO PERCA A OPORTUNIDADE DE SE QUALIFICAR E GARANTIR SUA SEGURANÇA NO TRABALHO!

{{hashtags}}`,
  },
  {
    name: 'Story / WhatsApp',
    kind: 'story',
    body: `{{curso}} · {{datas}}
📍 {{cidade_uf}}
💰 {{preco}}
Inscrições: {{link_inscricao}}`,
  },
];

/** Configurações padrão; os contatos vêm do cadastro da empresa quando existem. */
export interface MarketingSettings {
  whatsapp?: string;
  email?: string;
  site?: string;
  instagram?: string;
  horarioPadrao?: string;
  localPadrao?: string;
  inclusoPadrao?: string[];
  hashtagsPadrao?: string;
  hashtagsPorCurso?: Record<string, string>;
  linkInscricao?: 'turma' | 'pagina_curso' | 'site' | 'personalizado';
  linkPersonalizado?: string;
  selos?: string[];
  temaPadrao?: string;
  ultimasVagasLimite?: number;
}

export const DEFAULT_SETTINGS: MarketingSettings = {
  horarioPadrao: 'Das 08h às 17h',
  localPadrao: '',
  inclusoPadrao: ['Alojamento', 'Camisa', 'Apostila', 'Certificado'],
  hashtagsPadrao: '#worksafe #segurancanotrabalho #treinamento #trabalhoemaltura',
  hashtagsPorCurso: {},
  linkInscricao: 'turma',
  linkPersonalizado: '',
  selos: ['aneac', 'icra', 'opc'],
  temaPadrao: 'verde',
  ultimasVagasLimite: 5,
};
