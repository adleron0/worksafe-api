import { CertificateHighlightTheme } from '@prisma/client';

/**
 * Destaque efetivo de um certificado.
 *
 * - Aluno destaque (marcado no certificado): tema do certificado, senão o da
 *   turma, senão Ouro; faixa com o texto do certificado ou "Aluno Destaque".
 * - Turma especial (tema na turma): todos os certificados da turma, com o
 *   texto da turma ou "Turma Especial".
 * - Sem nada disso: sem destaque.
 *
 * O mesmo cálculo existe no front (visualizadorCertificados/highlight.ts) —
 * manter os dois iguais.
 */
export type HighlightKind = 'aluno' | 'turma';

export interface CertificateHighlight {
  kind: HighlightKind;
  theme: CertificateHighlightTheme;
  label: string;
}

interface HighlightSource {
  highlightStudent?: boolean | null;
  highlightTheme?: CertificateHighlightTheme | null;
  highlightLabel?: string | null;
  class?: {
    highlightTheme?: CertificateHighlightTheme | null;
    highlightLabel?: string | null;
  } | null;
}

export const HIGHLIGHT_DEFAULT_LABEL: Record<HighlightKind, string> = {
  aluno: 'Aluno Destaque',
  turma: 'Turma Especial',
};

export function resolveHighlight(
  cert: HighlightSource | null | undefined,
): CertificateHighlight | null {
  if (!cert) return null;
  if (cert.highlightStudent) {
    return {
      kind: 'aluno',
      theme: cert.highlightTheme ?? cert.class?.highlightTheme ?? 'ouro',
      label: cert.highlightLabel?.trim() || HIGHLIGHT_DEFAULT_LABEL.aluno,
    };
  }
  if (cert.class?.highlightTheme) {
    return {
      kind: 'turma',
      theme: cert.class.highlightTheme,
      label: cert.class.highlightLabel?.trim() || HIGHLIGHT_DEFAULT_LABEL.turma,
    };
  }
  return null;
}
