import {
  CertificateHighlightPattern,
  CertificateHighlightTheme,
} from '@prisma/client';

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
  /** Padronagem do centro (a borda sempre tem os brilhos). */
  pattern: CertificateHighlightPattern;
}

/** Padronagem de cada tema quando ninguém escolheu uma. */
export const DEFAULT_PATTERN: Record<
  CertificateHighlightTheme,
  CertificateHighlightPattern
> = {
  ouro: 'rosetas',
  prata: 'estilhacos',
  holografico: 'estrelas',
};

interface HighlightSource {
  highlightStudent?: boolean | null;
  highlightTheme?: CertificateHighlightTheme | null;
  highlightLabel?: string | null;
  highlightPattern?: CertificateHighlightPattern | null;
  class?: {
    highlightTheme?: CertificateHighlightTheme | null;
    highlightLabel?: string | null;
    highlightPattern?: CertificateHighlightPattern | null;
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
    const theme = cert.highlightTheme ?? cert.class?.highlightTheme ?? 'ouro';
    return {
      kind: 'aluno',
      theme,
      label: cert.highlightLabel?.trim() || HIGHLIGHT_DEFAULT_LABEL.aluno,
      pattern:
        cert.highlightPattern ??
        cert.class?.highlightPattern ??
        DEFAULT_PATTERN[theme],
    };
  }
  if (cert.class?.highlightTheme) {
    const theme = cert.class.highlightTheme;
    return {
      kind: 'turma',
      theme,
      label: cert.class.highlightLabel?.trim() || HIGHLIGHT_DEFAULT_LABEL.turma,
      pattern: cert.class.highlightPattern ?? DEFAULT_PATTERN[theme],
    };
  }
  return null;
}
