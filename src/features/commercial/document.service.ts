import { BadRequestException, ConflictException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { CommercialProposalKind, Prisma } from '@prisma/client';
import { randomInt, randomUUID } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { EmailService } from 'src/features/email/email.service';
import { ContractService } from './contract.service';
import { Annotation, Brand, DEFAULT_COLOR, ProposalImage, Schedule, safeImageUrl, validColor } from './document.blocks';
import { ITEMS_MODES, TermText, blank, clean, escape, sanitizeBody, sha256, validCpf } from './document.render';

export * from './document.render';
export { Brand, ProposalImage, Schedule } from './document.blocks';

type Body = Record<string, any>;
const KINDS: CommercialProposalKind[] = ['servico', 'treinamento', 'misto'];
const CODE_TTL_MINUTES = 15;
const CODE_MAX_ATTEMPTS = 5;

// ---------------------------------------------------------------- padrões

const DEFAULT_TERMS: Array<{ title: string; kind: string; body: string }> = [
  { title: 'Aceite', kind: 'aceite', body: '<p>O aceite desta proposta, por meio eletrônico ou por escrito, representa a concordância integral com o escopo, os valores, os prazos e as condições aqui descritos, e autoriza o início dos serviços nas datas combinadas. Quem aceita declara ter poderes para representar a contratante.</p>' },
  { title: 'Pagamento', kind: 'pagamento', body: '<p>Os pagamentos serão feitos nas datas indicadas nas condições de pagamento, mediante emissão de nota fiscal. Em caso de atraso incidem multa de 2% sobre o valor em atraso, juros de 1% ao mês e correção monetária, calculados até a data do efetivo pagamento.</p>' },
  { title: 'Reequilíbrio por mudança tributária ou trabalhista', kind: 'reequilibrio', body: '<p>Os valores desta proposta consideram a legislação tributária e trabalhista vigente na data de sua emissão. Havendo criação, alteração ou extinção de tributos, encargos ou regras de jornada entre o aceite e a execução que alterem comprovadamente o custo dos serviços, os valores serão revistos de comum acordo, na exata medida do impacto.</p>' },
  { title: 'Cancelamento e reagendamento', kind: 'cancelamento', body: '<p>O cancelamento ou o reagendamento solicitado pela contratante com menos de 5 (cinco) dias úteis de antecedência da data combinada sujeita a contratante ao ressarcimento dos custos já incorridos com mobilização, deslocamento, locações e reserva de equipe.</p>' },
  { title: 'Obrigações da contratante', kind: 'obrigacoes', body: '<p>Cabe à contratante garantir o acesso da equipe ao local, fornecer as informações e autorizações necessárias, indicar um responsável para acompanhamento e manter as condições de segurança da área que estiver sob sua responsabilidade. Atrasos causados por falta dessas condições poderão alterar o prazo e os valores.</p>' },
  { title: 'Confidencialidade', kind: 'confidencialidade', body: '<p>As partes se comprometem a manter em sigilo as informações técnicas e comerciais a que tiverem acesso em razão desta proposta e de sua execução, utilizando-as apenas para os fins aqui previstos.</p>' },
  { title: 'Proteção de dados', kind: 'lgpd', body: '<p>Os dados pessoais tratados em razão desta proposta e da execução dos serviços serão utilizados exclusivamente para essas finalidades, em conformidade com a Lei nº 13.709/2018 (LGPD).</p>' },
];

/**
 * Textos do modelo de orçamento. Substituem os termos iniciais de mesmo tipo
 * (só quando ainda não foram editados) e acrescentam os que faltavam.
 */
const CLASSIC_TERMS: Array<{ title: string; kind: string; body: string }> = [
  { title: 'Condições de pagamento', kind: 'pagamento', body: '<p>Os pagamentos seguem as parcelas e os vencimentos indicados nesta proposta e são feitos por transferência bancária ou PIX para a conta da CONTRATADA, mediante emissão de nota fiscal.</p>'
    + '<p>O atraso no pagamento sujeita a CONTRATANTE a multa de 2% sobre o valor em atraso, juros de mora de 1% ao mês e correção monetária pelo IPCA, calculados até a data do efetivo pagamento, e autoriza a CONTRATADA a suspender os serviços até a regularização.</p>' },
  { title: 'Mobilização e prazo', kind: 'mobilizacao', body: '<p>O prazo para mobilização da equipe e início das atividades é de 15 (quinze) dias, contados da confirmação do pagamento da parcela de mobilização, quando prevista, ou do aceite desta proposta. O prazo de execução é contado a partir da liberação da frente de serviço pela CONTRATANTE.</p>' },
  { title: 'Obrigações da contratada', kind: 'obrigacoes_contratada', body: '<ul>'
    + '<li>Arcar com a alimentação e o transporte da sua equipe de trabalho.</li>'
    + '<li>Cumprir os horários de trabalho combinados nesta proposta.</li>'
    + '<li>Entregar a documentação de segurança do trabalho exigida para a atividade, quando for de sua responsabilidade.</li>'
    + '<li>Fornecer os materiais e os equipamentos necessários à execução dos serviços descritos nesta proposta.</li>'
    + '<li>Emitir e enviar o relatório fotográfico das atividades em até 72 (setenta e duas) horas após a conclusão dos serviços.</li>'
    + '</ul>' },
  { title: 'Obrigações da contratante', kind: 'obrigacoes', body: '<p>Os serviços estão orçados em jornada administrativa, de segunda a sexta-feira, das 7h às 17h, com intervalo de 1 (uma) hora para refeição, sendo sábados e domingos dias de descanso.</p><ul>'
    + '<li>Liberar a frente de serviço na data e no horário combinados, com acesso, autorizações e condições de segurança da área sob sua responsabilidade, e indicar um responsável para acompanhar os trabalhos.</li>'
    + '<li>Trabalhos em fins de semana e feriados, quando solicitados pela CONTRATANTE, serão cobrados por aditivo, com acréscimo de 100% sobre o valor diário da mão de obra (valor total da mão de obra dividido por 30).</li>'
    + '<li>Horas extras devem ser solicitadas com antecedência, limitadas a 2 (duas) horas por expediente e respeitado o intervalo entre jornadas, e serão cobradas por aditivo, incluídos os custos adicionais de alimentação e transporte da equipe.</li>'
    + '<li>O atraso na liberação da frente de serviço por responsabilidade da CONTRATANTE sujeita-a a multa de 1% do valor total desta proposta por hora de atraso, sem prejuízo dos juros de mora de 1% ao mês e do ressarcimento dos custos adicionais comprovados, uma vez que o atraso compromete o prazo e estende a permanência da equipe.</li>'
    + '<li>Custos adicionais decorrentes de fatos não previstos no orçamento, como dificuldade ou impossibilidade de acesso ao local, condições climáticas, exigências administrativas ou aumento do dimensionamento, serão revistos por aditivo, de comum acordo entre as partes.</li>'
    + '</ul>' },
];
/** Ordem dos termos no modelo de orçamento. */
const CLASSIC_ORDER = ['pagamento', 'mobilizacao', 'obrigacoes_contratada', 'obrigacoes', 'cancelamento', 'reequilibrio', 'aceite', 'confidencialidade', 'lgpd'];

/**
 * Modelo de orçamento: a estrutura do orçamento que a empresa sempre usou.
 * As imagens ficam depois de "Outras informações", com título no mesmo estilo das condições
 * (o título some quando a proposta não tem imagem). As posições antigas existem só para
 * reconhecer, e atualizar, o modelo de quem ainda não o editou.
 */
type ImagesAt = 'objeto' | 'lista' | 'fim';
const classicBody = (training: boolean, images: ImagesAt = 'fim') => [
  '<p>{{cabecalho}}</p>', '<p>{{cliente}}</p>',
  '<h2>Objeto</h2>', '<p><strong>{{proposta.titulo}}</strong></p>', '<p>{{proposta.descricao}}</p>', ...(images === 'objeto' ? ['<p>{{imagens}}</p>'] : []),
  `<h2>${training ? 'Lista dos treinamentos' : 'Lista dos serviços'}</h2>`, '<p>{{tabela_itens}}</p>',
  '<p>Valor total desta proposta: <strong>{{valor.total}}</strong> ({{valor.total_extenso}}).</p>',
  ...(training ? ['<p>Estão incluídos instrutor habilitado, material didático e certificado para os participantes aprovados.</p>'] : []),
  ...(images === 'lista' ? ['<h2>Imagens de referência</h2>', '<p>{{imagens}}</p>'] : []),
  '<h2>Cronograma</h2>', '<p>{{cronograma}}</p>',
  '<h2>Vencimentos</h2>', '<p>{{condicoes_pagamento}}</p>',
  '<h2>Outras informações</h2>', '<p>{{informacoes}}</p>', '<p>{{dados_bancarios}}</p>',
  ...(images === 'fim' ? ['<h3>Imagens de referência</h3>', '<p>{{imagens}}</p>'] : []),
  '<p>{{termos}}</p>', '<p>{{rodape}}</p>',
].join('');
const classicServiceBody = classicBody(false), classicTrainingBody = classicBody(true);
/** Versões anteriores do modelo de orçamento: quem não editou recebe a atual. */
const CLASSIC_UPGRADES: Array<[string, string]> = (['objeto', 'lista'] as ImagesAt[]).flatMap((at) => [
  [classicBody(false, at), classicServiceBody], [classicBody(true, at), classicTrainingBody],
] as Array<[string, string]>);

const serviceBody = [
  '<h1>Proposta comercial {{proposta.numero}}</h1>',
  '<p><strong>{{cliente.razao_social}}</strong> — CNPJ {{cliente.cnpj}}</p>', '<p>A/C {{contato.nome}}</p>', '<p>{{proposta.data}}</p>',
  '<h2>1. Objeto</h2>', '<p><strong>{{proposta.titulo}}</strong></p>', '<p>{{proposta.descricao}}</p>',
  '<h2>2. Escopo e valores</h2>', '<p>{{tabela_itens}}</p>', '<p>Valor total desta proposta: <strong>{{valor.total}}</strong> ({{valor.total_extenso}}).</p>',
  '<h2>3. Prazo de execução</h2>', '<p>Prazo estimado de {{prazo.dias}} dias úteis, contados a partir da data de início combinada entre as partes.</p>',
  '<h2>4. Condições de pagamento</h2>', '<p>{{condicoes_pagamento}}</p>',
  '<h2>5. Validade</h2>', '<p>Esta proposta é válida até {{proposta.validade}}.</p>',
  '<h2>6. Condições gerais</h2>', '<p>{{termos}}</p>', '<p>{{assinatura}}</p>',
].join('');
const trainingBody = [
  '<h1>Proposta de treinamento {{proposta.numero}}</h1>',
  '<p><strong>{{cliente.razao_social}}</strong> — CNPJ {{cliente.cnpj}}</p>', '<p>A/C {{contato.nome}}</p>', '<p>{{proposta.data}}</p>',
  '<h2>1. Objeto</h2>', '<p><strong>{{proposta.titulo}}</strong></p>', '<p>{{proposta.descricao}}</p>',
  '<h2>2. Treinamentos e valores</h2>', '<p>{{tabela_itens}}</p>', '<p>Valor total desta proposta: <strong>{{valor.total}}</strong> ({{valor.total_extenso}}).</p>',
  '<p>Estão incluídos instrutor habilitado, material didático e emissão de certificado para os participantes aprovados.</p>',
  '<h2>3. Condições de pagamento</h2>', '<p>{{condicoes_pagamento}}</p>',
  '<h2>4. Validade</h2>', '<p>Esta proposta é válida até {{proposta.validade}}.</p>',
  '<h2>5. Condições gerais</h2>', '<p>{{termos}}</p>', '<p>{{assinatura}}</p>',
].join('');

/** Modelos com identidade: capa, resumo, imagens, investimento em destaque, quem somos e próximos passos. */
const brandedServiceBody = [
  '<p>{{capa}}</p>',
  '<h2>Em resumo</h2>', '<p>{{resumo}}</p>',
  '<h2>O que entendemos da sua necessidade</h2>', '<p>{{proposta.descricao}}</p>', '<p>{{imagens}}</p>',
  '<h2>O que vamos entregar</h2>', '<p>{{tabela_itens}}</p>',
  '<h2>Investimento</h2>', '<p>{{investimento}}</p>', '<p>{{condicoes_pagamento}}</p>',
  '<h2>Por que a {{empresa.nome}}</h2>', '<p>{{sobre}}</p>', '<p>{{depoimentos}}</p>',
  '<h2>Próximos passos</h2>', '<p>{{proximos_passos}}</p>',
  '<h2>Condições gerais</h2>', '<p>{{termos}}</p>', '<p>{{assinatura}}</p>', '<p>{{contato}}</p>',
].join('');
const brandedTrainingBody = [
  '<p>{{capa}}</p>',
  '<h2>Em resumo</h2>', '<p>{{resumo}}</p>',
  '<h2>O treinamento</h2>', '<p>{{proposta.descricao}}</p>', '<p>{{imagens}}</p>',
  '<h2>Turmas e valores</h2>', '<p>{{tabela_itens}}</p>',
  '<p>Estão incluídos instrutor habilitado, material didático e certificado para os participantes aprovados.</p>',
  '<h2>Investimento</h2>', '<p>{{investimento}}</p>', '<p>{{condicoes_pagamento}}</p>',
  '<h2>Por que a {{empresa.nome}}</h2>', '<p>{{sobre}}</p>', '<p>{{depoimentos}}</p>',
  '<h2>Próximos passos</h2>', '<p>{{proximos_passos}}</p>',
  '<h2>Condições gerais</h2>', '<p>{{termos}}</p>', '<p>{{assinatura}}</p>', '<p>{{contato}}</p>',
].join('');

/** Textos originais dos modelos anteriores ao modelo de orçamento (para reconhecer cópias sem edição). */
export const STOCK_BODIES = [serviceBody, trainingBody, brandedServiceBody, brandedTrainingBody];

const text = (value: unknown, max: number) => String(value ?? '').replace(/\r/g, '').trim().slice(0, max);
const pct = (value: unknown) => Math.round(Math.min(100, Math.max(0, Number(value) || 0)) * 100) / 100;

@Injectable()
export class DocumentService {
  constructor(private readonly prisma: PrismaService, private readonly email: EmailService, private readonly contracts: ContractService) {}

  // ------------------------------------------------------------------ carga

  /** Termos e modelos iniciais, na primeira vez que a empresa abre o cadastro ou envia uma proposta. */
  async ensureSeed(companyId: number): Promise<void> {
    if (await this.prisma.commercial_ProposalTemplate.findFirst({ where: { companyId }, select: { id: true } })) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(740116::int, ${companyId}::int)`;
      if (await tx.commercial_ProposalTemplate.findFirst({ where: { companyId }, select: { id: true } })) return;
      let termIds = (await tx.commercial_Term.findMany({ where: { companyId }, select: { id: true }, orderBy: { order: 'asc' } })).map((t) => t.id);
      if (!termIds.length) {
        for (const [order, term] of DEFAULT_TERMS.entries()) termIds.push((await tx.commercial_Term.create({ data: { companyId, ...term, order } })).id);
      }
      const trainingTerms = termIds.filter((_, i) => DEFAULT_TERMS[i]?.kind !== 'obrigacoes');
      await tx.commercial_ProposalTemplate.create({ data: { companyId, name: 'Proposta de serviço — completa', kind: 'servico', body: brandedServiceBody, termIds, isDefault: true } });
      await tx.commercial_ProposalTemplate.create({ data: { companyId, name: 'Proposta de treinamento — completa', kind: 'treinamento', body: brandedTrainingBody, termIds: trainingTerms } });
      await tx.commercial_ProposalTemplate.create({ data: { companyId, name: 'Proposta de serviço — simples', body: serviceBody, termIds } });
      await tx.commercial_ProposalTemplate.create({ data: { companyId, name: 'Proposta de treinamento — simples', body: trainingBody, termIds: trainingTerms } });
    });
  }

  // ------------------------------------------------------------------ termos

  async listTerms(companyId: number, includeInactive = false) {
    await this.ensureSeed(companyId);
    await this.ensureBrandedTemplates(companyId);
    await this.ensureClassicTemplates(companyId);
    return this.prisma.commercial_Term.findMany({ where: { companyId, ...(includeInactive ? {} : { inactiveAt: null }) }, orderBy: [{ order: 'asc' }, { id: 'asc' }] });
  }

  private parseTerm(body: Body, existing?: { title: string; kind: string; body: string; order: number }) {
    const title = clean('title' in body ? body.title : existing?.title, 160);
    if (title.length < 2) throw new BadRequestException('Informe o título do termo');
    const text = sanitizeBody('body' in body ? body.body : existing?.body);
    if (!text.replace(/<[^>]+>/g, '').trim()) throw new BadRequestException('Escreva o texto do termo');
    return { title, body: text, kind: clean('kind' in body ? body.kind : existing?.kind ?? 'geral', 30) || 'geral', order: Math.round(Number('order' in body ? body.order : existing?.order ?? 0)) || 0 };
  }

  async createTerm(companyId: number, body: Body) {
    await this.ensureSeed(companyId);
    return this.prisma.commercial_Term.create({ data: { companyId, ...this.parseTerm(body) } });
  }

  async updateTerm(companyId: number, id: number, body: Body) {
    const existing = await this.prisma.commercial_Term.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException('Termo não encontrado');
    return this.prisma.commercial_Term.update({ where: { id }, data: this.parseTerm(body, existing) });
  }

  async setTermActive(companyId: number, id: number, active: boolean) {
    const existing = await this.prisma.commercial_Term.findFirst({ where: { id, companyId }, select: { id: true } });
    if (!existing) throw new NotFoundException('Termo não encontrado');
    await this.prisma.commercial_Term.update({ where: { id }, data: { inactiveAt: active ? null : new Date() } });
    return { id, active };
  }

  /** Termos pedidos, na ordem pedida, só os ativos da empresa. */
  async termsByIds(companyId: number, ids: number[]): Promise<TermText[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.commercial_Term.findMany({ where: { companyId, id: { in: ids }, inactiveAt: null }, select: { id: true, title: true, body: true } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => byId.get(id)).filter((row): row is TermText => !!row);
  }

  async cleanTermIds(companyId: number, raw: unknown): Promise<number[]> {
    const ids = [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 40);
    return (await this.termsByIds(companyId, ids)).map((term) => term.id);
  }

  // ------------------------------------------------------------------ modelos

  /**
   * Empresas que já tinham os modelos simples ganham os modelos com identidade.
   * O novo só vira o padrão se o padrão atual ainda for o texto original, sem edição.
   */
  private async ensureBrandedTemplates(companyId: number): Promise<void> {
    const all = await this.prisma.commercial_ProposalTemplate.findMany({ where: { companyId }, select: { id: true, body: true, isDefault: true, kind: true, termIds: true } });
    if (!all.length || all.some((t) => t.body.includes('{{capa}}'))) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(740118::int, ${companyId}::int)`;
      if (await tx.commercial_ProposalTemplate.findFirst({ where: { companyId, body: { contains: '{{capa}}' } }, select: { id: true } })) return;
      const termIds = all.find((t) => t.kind === 'servico')?.termIds ?? all[0].termIds;
      const currentDefault = all.find((t) => t.isDefault);
      const takeDefault = !currentDefault || currentDefault.body === serviceBody;
      if (takeDefault) await tx.commercial_ProposalTemplate.updateMany({ where: { companyId, isDefault: true }, data: { isDefault: false } });
      // os modelos simples originais (sem edição) saem do caminho: o tipo da proposta passa a achar o novo
      const untouched = all.filter((t) => t.body === serviceBody || t.body === trainingBody).map((t) => t.id);
      if (untouched.length) await tx.commercial_ProposalTemplate.updateMany({ where: { id: { in: untouched } }, data: { kind: null, isDefault: false } });
      await tx.commercial_ProposalTemplate.create({ data: { companyId, name: 'Proposta de serviço — completa', kind: 'servico', body: brandedServiceBody, termIds, isDefault: takeDefault } });
      await tx.commercial_ProposalTemplate.create({ data: { companyId, name: 'Proposta de treinamento — completa', kind: 'treinamento', body: brandedTrainingBody, termIds: all.find((t) => t.kind === 'treinamento')?.termIds ?? termIds } });
      if (untouched.length) {
        await tx.commercial_ProposalTemplate.updateMany({ where: { id: { in: untouched }, body: serviceBody }, data: { name: 'Proposta de serviço — simples' } });
        await tx.commercial_ProposalTemplate.updateMany({ where: { id: { in: untouched }, body: trainingBody }, data: { name: 'Proposta de treinamento — simples' } });
      }
    });
  }

  /**
   * Modelo de orçamento (estrutura do orçamento que a empresa já usava) e os textos dele.
   * Termo inicial que ninguém editou é trocado pelo texto novo; o editado fica como está.
   * O modelo novo só vira o padrão se o padrão atual ainda for um dos textos originais.
   */
  private async ensureClassicTemplates(companyId: number): Promise<void> {
    const marker = '{{cabecalho}}';
    const all = await this.prisma.commercial_ProposalTemplate.findMany({ where: { companyId }, select: { id: true, body: true, isDefault: true } });
    // modelo de orçamento que ninguém editou acompanha a versão atual do texto padrão
    for (const [previous, current] of CLASSIC_UPGRADES) {
      const stale = all.filter((t) => t.body === previous).map((t) => t.id);
      if (stale.length) await this.prisma.commercial_ProposalTemplate.updateMany({ where: { id: { in: stale }, body: previous }, data: { body: current } });
    }
    if (!all.length || all.some((t) => t.body.includes(marker))) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(740119::int, ${companyId}::int)`;
      if (await tx.commercial_ProposalTemplate.findFirst({ where: { companyId, body: { contains: marker } }, select: { id: true } })) return;
      const terms = await tx.commercial_Term.findMany({ where: { companyId }, orderBy: [{ order: 'asc' }, { id: 'asc' }] });
      const byKind = new Map(terms.map((term) => [term.kind, term]));
      for (const fresh of CLASSIC_TERMS) {
        const current = byKind.get(fresh.kind);
        const original = DEFAULT_TERMS.find((term) => term.kind === fresh.kind);
        if (!current) byKind.set(fresh.kind, await tx.commercial_Term.create({ data: { companyId, ...fresh, order: CLASSIC_ORDER.indexOf(fresh.kind) } }));
        else if (original && current.body === original.body && current.title === original.title) {
          byKind.set(fresh.kind, await tx.commercial_Term.update({ where: { id: current.id }, data: { title: fresh.title, body: fresh.body } }));
        }
      }
      // a lista de termos passa a seguir a ordem em que eles aparecem no orçamento
      for (const [order, kind] of CLASSIC_ORDER.entries()) {
        const term = byKind.get(kind);
        if (term && term.order !== order) await tx.commercial_Term.update({ where: { id: term.id }, data: { order } });
      }
      const termIds = CLASSIC_ORDER.map((kind) => byKind.get(kind)).filter((term) => term && !term.inactiveAt).map((term) => term!.id);
      const originals = [serviceBody, trainingBody, brandedServiceBody, brandedTrainingBody];
      const currentDefault = all.find((t) => t.isDefault);
      const takeDefault = !currentDefault || originals.includes(currentDefault.body);
      // os modelos originais (sem edição) saem do caminho: o tipo da proposta passa a achar o modelo de orçamento
      const untouched = all.filter((t) => originals.includes(t.body)).map((t) => t.id);
      if (untouched.length) await tx.commercial_ProposalTemplate.updateMany({ where: { id: { in: untouched } }, data: takeDefault ? { kind: null, isDefault: false } : { kind: null } });
      if (takeDefault) await tx.commercial_ProposalTemplate.updateMany({ where: { companyId, isDefault: true }, data: { isDefault: false } });
      await tx.commercial_ProposalTemplate.create({ data: { companyId, name: 'Orçamento de serviço', kind: 'servico', body: classicServiceBody, termIds, isDefault: takeDefault } });
      await tx.commercial_ProposalTemplate.create({ data: { companyId, name: 'Orçamento de treinamento', kind: 'treinamento', body: classicTrainingBody, termIds } });
    });
  }

  // ------------------------------------------------------------------ identidade

  /** Identidade usada nas propostas: o que foi configurado, completado pelo cadastro da empresa. */
  async brand(companyId: number): Promise<Brand> {
    const [settings, company] = await Promise.all([
      this.prisma.commercial_Settings.findUnique({ where: { companyId } }),
      this.prisma.company.findUnique({ where: { id: companyId }, select: {
        logoUrl: true, primary_color: true, description: true, representative_contact: true, representative_email: true, websiteUrl: true,
        address: true, addressNumber: true, neighborhood: true,
      } }),
    ]);
    const saved = (settings?.brand ?? {}) as Partial<Brand>;
    const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
    return {
      logoUrl: safeImageUrl(saved.logoUrl) ?? safeImageUrl(company?.logoUrl),
      color: validColor(saved.color ?? company?.primary_color ?? DEFAULT_COLOR),
      tagline: saved.tagline ?? company?.description ?? '',
      about: saved.about ?? '',
      highlights: list<Brand['highlights'][number]>(saved.highlights), differentials: list<Brand['differentials'][number]>(saved.differentials),
      testimonials: list<Brand['testimonials'][number]>(saved.testimonials),
      phone: saved.phone ?? company?.representative_contact ?? '', email: saved.email ?? company?.representative_email ?? '',
      website: saved.website ?? company?.websiteUrl ?? '',
      address: saved.address ?? [company?.address, company?.addressNumber, company?.neighborhood].filter(Boolean).join(', '),
      registrations: saved.registrations ?? '', payment: saved.payment ?? '',
      serviceEmail: saved.serviceEmail ?? '', trainingEmail: saved.trainingEmail ?? '',
    };
  }

  async updateBrand(companyId: number, body: Body): Promise<Brand> {
    const rows = <T>(raw: unknown, max: number, map: (entry: Body) => T | null): T[] =>
      (Array.isArray(raw) ? raw : []).slice(0, max).map((entry) => map((entry ?? {}) as Body)).filter((entry): entry is T => entry !== null);
    if (!blank(body.logoUrl) && !safeImageUrl(body.logoUrl)) throw new BadRequestException('A logo precisa ser um endereço https');
    if (!blank(body.color) && !/^#[0-9a-f]{6}$/i.test(String(body.color))) throw new BadRequestException('Cor inválida: use o formato #RRGGBB');
    for (const [key, label] of [['email', 'E-mail de contato'], ['serviceEmail', 'E-mail de serviços'], ['trainingEmail', 'E-mail de treinamentos']]) {
      if (!blank(body[key]) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body[key]))) throw new BadRequestException(`${label} inválido`);
    }
    const brand = {
      logoUrl: blank(body.logoUrl) ? null : safeImageUrl(body.logoUrl), color: blank(body.color) ? null : validColor(body.color),
      tagline: text(body.tagline, 200), about: text(body.about, 2000),
      highlights: rows(body.highlights, 4, (e) => (text(e.value, 20) ? { value: text(e.value, 20), label: text(e.label, 60) } : null)),
      differentials: rows(body.differentials, 6, (e) => (text(e.title, 80) ? { title: text(e.title, 80), text: text(e.text, 300) } : null)),
      testimonials: rows(body.testimonials, 3, (e) => (text(e.quote, 500) ? { quote: text(e.quote, 500), author: text(e.author, 80), company: text(e.company, 80) } : null)),
      phone: text(body.phone, 60), email: text(body.email, 255), website: text(body.website, 255), address: text(body.address, 255),
      registrations: text(body.registrations, 300), payment: text(body.payment, 1000),
      serviceEmail: text(body.serviceEmail, 255), trainingEmail: text(body.trainingEmail, 255),
    };
    // campo vazio volta a valer o cadastro da empresa: guarda só o que foi preenchido
    const stored = Object.fromEntries(Object.entries(brand).filter(([key, value]) =>
      ['highlights', 'differentials', 'testimonials', 'about'].includes(key) || (value !== null && value !== '')));
    await this.prisma.commercial_Settings.upsert({ where: { companyId }, update: { brand: stored as Prisma.InputJsonValue }, create: { companyId, brand: stored as Prisma.InputJsonValue } });
    return this.brand(companyId);
  }

  /** Imagens da proposta: só https, textos limitados e marcações em percentual da imagem. */
  parseImages(raw: unknown): ProposalImage[] {
    if (!Array.isArray(raw)) return [];
    if (raw.length > 12) throw new BadRequestException('No máximo 12 imagens por proposta');
    return raw.map((entry: Body, index) => {
      const url = safeImageUrl(entry?.url);
      if (!url) throw new BadRequestException(`Imagem ${index + 1}: endereço inválido`);
      const marks = Array.isArray(entry.annotations) ? entry.annotations.slice(0, 20) : [];
      const annotations: Annotation[] = marks.map((mark: Body) => (mark?.type === 'seta'
        ? { type: 'seta', x1: pct(mark.x1), y1: pct(mark.y1), x2: pct(mark.x2), y2: pct(mark.y2), label: text(mark.label, 160) }
        : { type: 'circulo', x: pct(mark.x), y: pct(mark.y), w: pct(mark.w), h: pct(mark.h), label: text(mark.label, 160) }));
      return { url, title: text(entry.title, 120), description: text(entry.description, 600), annotations };
    });
  }

  /** Cronograma da proposta: até 20 etapas, cada uma com início e duração na unidade escolhida. */
  parseSchedule(raw: unknown): Schedule {
    const input = (raw ?? {}) as Body;
    const unit = (['dia', 'semana', 'mes'].includes(input.unit) ? input.unit : 'dia') as Schedule['unit'];
    const list = Array.isArray(input.steps) ? input.steps : [];
    if (list.length > 20) throw new BadRequestException('No máximo 20 etapas no cronograma');
    const whole = (value: unknown, label: string, index: number) => {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n) || n < 1 || n > 240) throw new BadRequestException(`Cronograma, etapa ${index + 1}: ${label} deve ficar entre 1 e 240`);
      return n;
    };
    const steps = list.map((entry: Body, index: number) => {
      const title = text(entry?.title, 80);
      if (!title) throw new BadRequestException(`Cronograma, etapa ${index + 1}: informe o nome da etapa`);
      return { title, start: whole(entry.start, 'o início', index), duration: whole(entry.duration, 'a duração', index) };
    });
    return { unit, steps };
  }

  async listTemplates(companyId: number, includeInactive = false) {
    await this.ensureSeed(companyId);
    await this.ensureBrandedTemplates(companyId);
    await this.ensureClassicTemplates(companyId);
    return this.prisma.commercial_ProposalTemplate.findMany({ where: { companyId, ...(includeInactive ? {} : { inactiveAt: null }) }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
  }

  private async parseTemplate(companyId: number, body: Body, existing?: Prisma.Commercial_ProposalTemplateGetPayload<Record<string, never>>) {
    const pick = <T>(key: string, fallback: T) => (key in body ? body[key] : fallback);
    const name = clean(pick('name', existing?.name), 120);
    if (name.length < 2) throw new BadRequestException('Informe o nome do modelo');
    const text = sanitizeBody(pick('body', existing?.body));
    if (!text.replace(/<[^>]+>/g, '').trim()) throw new BadRequestException('Escreva o texto do modelo');
    const kind = pick('kind', existing?.kind ?? null);
    const itemsMode = pick('itemsMode', existing?.itemsMode ?? 'detalhado');
    return {
      name, body: text, kind: KINDS.includes(kind) ? (kind as CommercialProposalKind) : null,
      itemsMode: ITEMS_MODES.includes(itemsMode) ? String(itemsMode) : 'detalhado',
      termIds: await this.cleanTermIds(companyId, pick('termIds', existing?.termIds ?? [])),
      isDefault: 'isDefault' in body ? body.isDefault === true || body.isDefault === 'true' : existing?.isDefault ?? false,
    };
  }

  private async singleDefault(companyId: number, id: number) {
    await this.prisma.commercial_ProposalTemplate.updateMany({ where: { companyId, isDefault: true, NOT: { id } }, data: { isDefault: false } });
  }

  async createTemplate(companyId: number, body: Body) {
    await this.ensureSeed(companyId);
    const created = await this.prisma.commercial_ProposalTemplate.create({ data: { companyId, ...(await this.parseTemplate(companyId, body)) } });
    if (created.isDefault) await this.singleDefault(companyId, created.id);
    return created;
  }

  async updateTemplate(companyId: number, id: number, body: Body) {
    const existing = await this.prisma.commercial_ProposalTemplate.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException('Modelo não encontrado');
    const updated = await this.prisma.commercial_ProposalTemplate.update({ where: { id }, data: await this.parseTemplate(companyId, body, existing) });
    if (updated.isDefault) await this.singleDefault(companyId, id);
    return updated;
  }

  async setTemplateActive(companyId: number, id: number, active: boolean) {
    const existing = await this.prisma.commercial_ProposalTemplate.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException('Modelo não encontrado');
    if (!active) {
      const others = await this.prisma.commercial_ProposalTemplate.count({ where: { companyId, inactiveAt: null, NOT: { id } } });
      if (!others) throw new ConflictException('Este é o único modelo ativo');
    }
    await this.prisma.commercial_ProposalTemplate.update({ where: { id }, data: { inactiveAt: active ? null : new Date(), ...(active ? {} : { isDefault: false }) } });
    return { id, active };
  }

  /** Modelo a usar quando a proposta ainda não tem documento: o do tipo dela, senão o padrão. */
  async templateFor(companyId: number, kind: CommercialProposalKind, id?: number | null) {
    const all = await this.listTemplates(companyId);
    return (id ? all.find((t) => t.id === id) : undefined) ?? all.find((t) => t.kind === kind) ?? all.find((t) => t.isDefault) ?? all[0] ?? null;
  }

  // ------------------------------------------------------------------ eventos

  event(proposal: { id: number; companyId: number }, type: string, extra: Partial<Prisma.Commercial_ProposalEventUncheckedCreateInput> = {}, tx: Prisma.TransactionClient | PrismaService = this.prisma) {
    return tx.commercial_ProposalEvent.create({ data: { companyId: proposal.companyId, proposalId: proposal.id, type, ...extra } });
  }

  events(proposalId: number) {
    return this.prisma.commercial_ProposalEvent.findMany({ where: { proposalId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  }

  // ------------------------------------------------------------------ e-mail

  emailConfigured(): boolean {
    return Boolean(process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD);
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.emailConfigured()) throw new BadRequestException('O envio de e-mail não está configurado. Copie o link e envie por outro canal.');
    this.email.initialize({
      host: process.env.EMAIL_HOST!, port: parseInt(process.env.EMAIL_PORT || '587', 10), secure: process.env.EMAIL_SECURE === 'true',
      auth: { user: process.env.EMAIL_USER!, pass: process.env.EMAIL_PASSWORD! }, from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    });
    try {
      await this.email.sendEmail({ to, subject, html });
    } catch {
      throw new BadRequestException('Não foi possível enviar o e-mail agora. Copie o link e envie por outro canal.');
    }
  }

  async publicUrl(companyId: number, key: string): Promise<string | null> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { system_domain: true } });
    const domain = clean(company?.system_domain).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return domain ? `https://${domain}/proposta/${key}` : null;
  }

  /** Envia o link da proposta por e-mail (quando o e-mail da empresa está configurado). */
  async sendLink(proposal: { id: number; companyId: number; number: string; title: string; publicKey: string | null }, body: Body, userId: number) {
    if (!proposal.publicKey) throw new ConflictException('A proposta ainda não foi enviada: não há link');
    const to = clean(body.to, 255);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new BadRequestException('Informe um e-mail válido');
    const url = await this.publicUrl(proposal.companyId, proposal.publicKey);
    if (!url) throw new BadRequestException('O domínio do sistema não está cadastrado na empresa: copie o link pela tela');
    const company = await this.prisma.company.findUnique({ where: { id: proposal.companyId }, select: { comercial_name: true } });
    const message = clean(body.message, 2000);
    await this.send(to, `Proposta ${proposal.number} — ${company?.comercial_name ?? ''}`.trim(),
      `<p>Olá,</p><p>${escape(message || `Segue a proposta ${proposal.number} — ${proposal.title}.`)}</p>`
      + `<p><a href="${escape(url)}">Abrir a proposta</a></p><p>Pelo link você pode ler, imprimir e registrar o aceite.</p><p>${escape(company?.comercial_name ?? '')}</p>`);
    await this.event(proposal, 'email_enviado', { userId: userId || null, email: to });
    return { sent: true, to };
  }

  // ------------------------------------------------------------------ página pública

  private async byKey(key: string) {
    if (!/^[a-f0-9-]{20,40}$/i.test(String(key))) throw new NotFoundException('Proposta não encontrada');
    const row = await this.prisma.commercial_Proposal.findFirst({
      where: { publicKey: key, inactiveAt: null },
      select: { id: true, companyId: true, number: true, title: true, status: true, validUntil: true, frozenHtml: true, frozenHash: true, viewedAt: true,
        contactEmail: true, rootId: true, decidedAt: true, total: true, sellerId: true, acceptCodeHash: true, acceptCodeExpiresAt: true, acceptCodeAttempts: true },
    });
    if (!row || !row.frozenHtml) throw new NotFoundException('Proposta não encontrada');
    return row;
  }

  /** Vencida a validade, a proposta em negociação passa a expirada. */
  private async expireIfDue<T extends { id: number; companyId: number; status: string; validUntil: Date | null }>(row: T): Promise<T> {
    if ((row.status === 'enviada' || row.status === 'visualizada') && row.validUntil && row.validUntil.toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10)) {
      const changed = await this.prisma.commercial_Proposal.updateMany({ where: { id: row.id, status: { in: ['enviada', 'visualizada'] } }, data: { status: 'expirada' } });
      if (changed.count) await this.event(row, 'expirada');
      return { ...row, status: 'expirada' };
    }
    return row;
  }

  /** Mesma regra, para a lista e a tela interna: expira todas as vencidas da empresa. */
  async expireDue(companyId: number): Promise<void> {
    const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const due = await this.prisma.commercial_Proposal.findMany({ where: { companyId, status: { in: ['enviada', 'visualizada'] }, validUntil: { lt: today } }, select: { id: true, companyId: true, status: true, validUntil: true } });
    for (const row of due) await this.expireIfDue(row);
  }

  private maskEmail(email: string | null) {
    if (!email || !email.includes('@')) return null;
    const [user, domain] = email.split('@');
    return `${user.slice(0, 2)}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
  }

  private codeRequired(row: { contactEmail: string | null }) {
    return this.emailConfigured() && Boolean(row.contactEmail);
  }

  /** O que o cliente vê pelo link. Lista branca: só o documento congelado e a situação. */
  async publicView(key: string, meta: { ip: string | null; userAgent: string | null }) {
    let row = await this.expireIfDue(await this.byKey(key));
    if (row.status === 'enviada') {
      const changed = await this.prisma.commercial_Proposal.updateMany({ where: { id: row.id, status: 'enviada' }, data: { status: 'visualizada', viewedAt: new Date() } });
      if (changed.count) await this.event(row, 'visualizada', { ip: meta.ip, userAgent: meta.userAgent });
      row = { ...row, status: 'visualizada' };
    }
    const [company, brand, seller] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: row.companyId }, select: { comercial_name: true } }),
      this.brand(row.companyId),
      row.sellerId ? this.prisma.user.findUnique({ where: { id: row.sellerId }, select: { name: true } }) : null,
    ]);
    const open = row.status === 'visualizada';
    const accepted = row.status === 'aceita'
      ? await this.prisma.commercial_ProposalEvent.findFirst({ where: { proposalId: row.id, type: 'aceita' }, orderBy: { id: 'desc' }, select: { name: true, role: true, createdAt: true } })
      : null;
    return {
      company: { name: company?.comercial_name ?? '', logoUrl: brand.logoUrl, color: brand.color },
      // para a barra de ação da página: valor e com quem falar
      total: Number(row.total), contact: { name: seller?.name ?? null, phone: brand.phone || null, email: brand.email || null },
      number: row.number, title: row.title, status: row.status, validUntil: row.validUntil ? row.validUntil.toISOString().slice(0, 10) : null,
      // versão substituída ou cancelada não mostra mais o conteúdo
      html: row.status === 'substituida' || row.status === 'cancelada' ? null : row.frozenHtml, hash: row.frozenHash,
      canDecide: open, requiresCode: open && this.codeRequired(row), codeEmail: open && this.codeRequired(row) ? this.maskEmail(row.contactEmail) : null,
      accepted: accepted ? { name: accepted.name, role: accepted.role, at: accepted.createdAt } : null,
    };
  }

  private async openForDecision(key: string) {
    const row = await this.expireIfDue(await this.byKey(key));
    if (row.status === 'enviada' || row.status === 'visualizada') return row;
    if (row.status === 'expirada') throw new GoneException('A validade desta proposta venceu. Peça uma versão atualizada.');
    if (row.status === 'substituida') throw new GoneException('Esta proposta foi substituída por uma versão mais nova.');
    throw new ConflictException(row.status === 'aceita' ? 'Esta proposta já foi aceita.' : 'Esta proposta não está mais disponível para decisão.');
  }

  /** Código de 6 dígitos para o e-mail do contato da proposta. */
  async requestCode(key: string) {
    const row = await this.openForDecision(key);
    if (!this.codeRequired(row)) return { required: false };
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    await this.send(row.contactEmail!, `Código de confirmação — proposta ${row.number}`,
      `<p>Use o código abaixo para confirmar o aceite da proposta ${escape(row.number)}:</p><p style="font-size:24px;letter-spacing:4px"><strong>${code}</strong></p><p>O código vale por ${CODE_TTL_MINUTES} minutos. Se você não pediu este código, ignore este e-mail.</p>`);
    await this.prisma.commercial_Proposal.update({ where: { id: row.id }, data: {
      acceptCodeHash: sha256(`${row.id}:${code}`), acceptCodeExpiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60000), acceptCodeAttempts: 0,
    } });
    await this.event(row, 'codigo_enviado', { email: row.contactEmail });
    return { required: true, sentTo: this.maskEmail(row.contactEmail) };
  }

  async accept(key: string, body: Body, meta: { ip: string | null; userAgent: string | null }) {
    const row = await this.openForDecision(key);
    const name = clean(body.name, 160), role = clean(body.role, 120), email = clean(body.email, 255);
    const cpf = String(body.cpf ?? '').replace(/\D/g, '');
    if (name.split(' ').length < 2) throw new BadRequestException('Informe o nome completo');
    if (!validCpf(cpf)) throw new BadRequestException('CPF inválido');
    if (role.length < 2) throw new BadRequestException('Informe o cargo');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Informe um e-mail válido');
    if (body.declaration !== true) throw new BadRequestException('É preciso declarar que tem poderes para representar a empresa');
    if (body.termsAccepted !== true) throw new BadRequestException('É preciso concordar com os termos da proposta');
    // quem aceita tem de ter lido exatamente este documento
    if (!blank(body.hash) && body.hash !== row.frozenHash) throw new ConflictException('O documento mudou. Recarregue a página.');

    const required = this.codeRequired(row);
    if (required) {
      if (!row.acceptCodeHash || !row.acceptCodeExpiresAt) throw new BadRequestException('Peça o código de confirmação');
      if (row.acceptCodeExpiresAt.getTime() < Date.now()) throw new BadRequestException('O código venceu. Peça um novo.');
      if (row.acceptCodeAttempts >= CODE_MAX_ATTEMPTS) throw new BadRequestException('Muitas tentativas. Peça um novo código.');
      if (sha256(`${row.id}:${String(body.code ?? '').replace(/\D/g, '')}`) !== row.acceptCodeHash) {
        await this.prisma.commercial_Proposal.update({ where: { id: row.id }, data: { acceptCodeAttempts: { increment: 1 } } });
        throw new BadRequestException('Código incorreto');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.commercial_Proposal.updateMany({ where: { id: row.id, status: { in: ['enviada', 'visualizada'] } }, data: {
        status: 'aceita', decidedAt: new Date(), acceptCodeHash: null, acceptCodeExpiresAt: null, statusNote: `Aceite eletrônico por ${name}`.slice(0, 500),
      } });
      if (!changed.count) throw new ConflictException('Esta proposta não está mais disponível para decisão.');
      await this.event(row, 'aceita', { ip: meta.ip, userAgent: meta.userAgent, name, cpf, role, email, documentHash: row.frozenHash, codeVerified: required }, tx);
      // a proposta aceita vira contrato na mesma transação
      await this.contracts.createFromProposal(tx, row.id, { name, cpf, role, email, ip: meta.ip, userAgent: meta.userAgent, at: new Date().toISOString(), codeVerified: required, manual: false });
    });
    return { status: 'aceita', name, hash: row.frozenHash };
  }

  async refuse(key: string, body: Body, meta: { ip: string | null; userAgent: string | null }) {
    const row = await this.openForDecision(key);
    const name = clean(body.name, 160);
    if (name.length < 2) throw new BadRequestException('Informe seu nome');
    const reason = clean(body.reason, 1000);
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.commercial_Proposal.updateMany({ where: { id: row.id, status: { in: ['enviada', 'visualizada'] } }, data: {
        status: 'recusada', decidedAt: new Date(), statusNote: `Recusada por ${name}${reason ? `: ${reason}` : ''}`.slice(0, 500),
      } });
      if (!changed.count) throw new ConflictException('Esta proposta não está mais disponível para decisão.');
      await this.event(row, 'recusada', { ip: meta.ip, userAgent: meta.userAgent, name, note: reason || null, documentHash: row.frozenHash }, tx);
    });
    return { status: 'recusada' };
  }

  newKey(): string {
    return randomUUID();
  }
}
