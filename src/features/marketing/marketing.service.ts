import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AIService } from 'src/common/ai';
import { PrismaService } from 'src/prisma/prisma.service';
import { DEFAULT_CAPTIONS, DEFAULT_SETTINGS, MarketingSettings } from './defaults';

const str = (value: unknown, max = 500) => String(value ?? '').trim().slice(0, max);

/** Campos aceitos nas configurações (o resto é ignorado). */
function sanitize(input: Record<string, any>): MarketingSettings {
  const out: MarketingSettings = {};
  for (const key of ['whatsapp', 'email', 'site', 'instagram', 'horarioPadrao', 'localPadrao', 'hashtagsPadrao', 'linkPersonalizado', 'temaPadrao'] as const) {
    if (key in input) out[key] = str(input[key], key === 'hashtagsPadrao' ? 1000 : 255);
  }
  if ('linkInscricao' in input) {
    out.linkInscricao = ['turma', 'pagina_curso', 'site', 'personalizado'].includes(input.linkInscricao) ? input.linkInscricao : 'turma';
  }
  if ('inclusoPadrao' in input) {
    const list = Array.isArray(input.inclusoPadrao) ? input.inclusoPadrao : String(input.inclusoPadrao ?? '').split('\n');
    out.inclusoPadrao = list.map((item: unknown) => str(item, 80)).filter(Boolean).slice(0, 12);
  }
  if ('selos' in input && Array.isArray(input.selos)) out.selos = input.selos.map((s: unknown) => str(s, 40)).filter(Boolean);
  if ('hashtagsPorCurso' in input && input.hashtagsPorCurso && typeof input.hashtagsPorCurso === 'object') {
    out.hashtagsPorCurso = Object.fromEntries(
      Object.entries(input.hashtagsPorCurso).map(([k, v]) => [String(Number(k)), str(v, 1000)]).filter(([k, v]) => k !== 'NaN' && v),
    );
  }
  if ('ultimasVagasLimite' in input) out.ultimasVagasLimite = Math.max(0, Math.min(100, Number(input.ultimasVagasLimite) || 0));
  return out;
}

@Injectable()
export class MarketingService {
  private readonly logger = new Logger(MarketingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AIService,
  ) {}

  /**
   * Configurações da empresa. Na primeira vez cria o registro com os contatos
   * do cadastro da empresa e os modelos de legenda padrão.
   */
  async getSettings(companyId: number) {
    const existing = await this.prisma.marketing_Setting.findUnique({ where: { companyId } });
    if (existing) return this.withCompany(companyId, existing.data as MarketingSettings);

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { comercial_name: true, operational_contact: true, representative_contact: true, operational_email: true, representative_email: true, websiteUrl: true, lp_domain: true, instagramUrl: true },
    });
    const site = company?.websiteUrl || (company?.lp_domain ? `https://${company.lp_domain}` : '');
    const data: MarketingSettings = {
      ...DEFAULT_SETTINGS,
      whatsapp: company?.operational_contact || company?.representative_contact || '',
      email: company?.operational_email || company?.representative_email || '',
      site,
      instagram: company?.instagramUrl || '',
      localPadrao: company?.comercial_name ? `Centro de Treinamentos da ${company.comercial_name}` : '',
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.marketing_Setting.upsert({ where: { companyId }, create: { companyId, data: data as any }, update: {} });
      const hasCaptions = await tx.marketing_CaptionTemplate.count({ where: { companyId } });
      if (!hasCaptions) {
        await tx.marketing_CaptionTemplate.createMany({
          data: DEFAULT_CAPTIONS.map((c, index) => ({ companyId, ...c, sortOrder: index })),
        });
      }
    });
    return this.withCompany(companyId, data);
  }

  async updateSettings(companyId: number, body: Record<string, any>) {
    const current = (await this.getSettings(companyId)).settings;
    const data = { ...current, ...sanitize(body ?? {}) };
    await this.prisma.marketing_Setting.update({ where: { companyId }, data: { data: data as any } });
    return this.withCompany(companyId, data);
  }

  /** Recria os modelos padrão que faltarem (pelo nome), sem mexer nos editados. */
  async restoreDefaultCaptions(companyId: number) {
    await this.getSettings(companyId);
    const existing = await this.prisma.marketing_CaptionTemplate.findMany({
      where: { companyId, inactiveAt: null }, select: { name: true },
    });
    const names = new Set(existing.map((e) => e.name.toLowerCase()));
    const missing = DEFAULT_CAPTIONS.filter((c) => !names.has(c.name.toLowerCase()));
    if (missing.length) {
      await this.prisma.marketing_CaptionTemplate.createMany({
        data: missing.map((c) => ({ companyId, ...c, sortOrder: DEFAULT_CAPTIONS.indexOf(c) })),
      });
    }
    return { created: missing.length };
  }

  /** Dados da empresa que a arte usa (nome e logo) junto das configurações. */
  private async withCompany(companyId: number, settings: MarketingSettings) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { comercial_name: true, logoUrl: true, lp_domain: true, primary_color: true },
    });
    return {
      settings: { ...DEFAULT_SETTINGS, ...settings },
      company: {
        name: company?.comercial_name ?? '',
        logoUrl: company?.logoUrl ?? null,
        siteDomain: company?.lp_domain ?? null,
        primaryColor: company?.primary_color ?? null,
      },
    };
  }

  /**
   * Reescreve a legenda com IA mantendo os dados. A legenda já chega pronta
   * (variáveis resolvidas no navegador); a IA só muda gancho, ritmo e chamada.
   */
  async rewriteCaption(body: Record<string, any>) {
    const caption = str(body?.caption, 4000);
    if (caption.length < 20) throw new BadRequestException('Gere a legenda antes de pedir a variação');
    const styles: Record<string, string> = {
      variar: 'Varie o gancho inicial e a chamada final, mantendo o tamanho parecido.',
      urgente: 'Deixe o texto mais urgente (vagas limitadas, data chegando), sem exagero.',
      curto: 'Deixe o texto bem mais curto e direto, ideal para quem lê rápido.',
      amigavel: 'Deixe o tom mais próximo e amigável, conversando com o profissional.',
      profissional: 'Deixe o tom mais institucional e técnico, valorizando certificação e qualidade.',
    };
    const style = styles[String(body?.style)] ?? styles.variar;
    const prompt = `Você escreve legendas de Instagram para um centro de treinamentos de segurança do trabalho no Brasil (trabalho em altura, espaço confinado, acesso por corda, resgate).

Reescreva a legenda abaixo. ${style}

Regras obrigatórias:
- Mantenha EXATAMENTE todos os dados: nome do curso, datas, horários, carga horária, local, valores, níveis, itens inclusos, telefones, e-mails, links e hashtags.
- Não invente nenhuma informação nova (nada de vagas, descontos, brindes ou datas que não estejam no texto).
- Português do Brasil, gramática correta.
- Use emojis com moderação, no começo de linhas, como no original.
- Mantenha as hashtags no final, iguais.
- Responda SOMENTE com a legenda pronta, sem comentários, aspas ou explicações.

Legenda original:
"""
${caption}
"""`;
    try {
      const text = (await this.ai.generateContent(prompt))
        .replace(/^\s*"""|"""\s*$/g, '')
        .split('\n').map((line) => line.replace(/\s+$/, '')).join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (!text) throw new Error('resposta vazia');
      return { caption: text };
    } catch (error) {
      this.logger.warn(`Falha ao gerar legenda com IA: ${(error as Error).message}`);
      throw new ServiceUnavailableException('A IA não respondeu agora. Tente de novo em instantes.');
    }
  }
}
