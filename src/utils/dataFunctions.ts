/*
 * Função para calcular data de vencimento.
 @param years - Número de anos para adicionar à data atual.
 * @returns Data de vencimento.
 */
export const getExpirationDate = (years: number) => {
  const date = new Date();
  date.setFullYear(date.getFullYear() + years);
  return date;
};
