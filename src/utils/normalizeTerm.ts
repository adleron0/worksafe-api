// utils/string.ts
export const normalizeTerm = (term: string) =>
  term
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
