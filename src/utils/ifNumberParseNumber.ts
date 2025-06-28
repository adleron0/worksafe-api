export function ifNumberParseNumber(valor: any): any {
  // Verifica se já é um número
  if (typeof valor === 'number') return valor;

  // Verifica se é um booleano
  if (typeof valor === 'boolean') return valor;

  // Valor é null ou undefined
  if (!valor || Array.isArray(valor)) return valor;

  // se começar com 0 ou tiver ponto, trata como string
  const num =
    valor.startsWith('0') || valor.includes('.') || valor.includes(',')
      ? valor
      : Number(valor);

  const result = isNaN(num) ? valor : num;

  return result;
}
