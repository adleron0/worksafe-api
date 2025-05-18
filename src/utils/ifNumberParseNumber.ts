export function ifNumberParseNumber(valor: any): any {
  // Verifica se já é um número
  if (typeof valor === 'number') return valor;

  // Verifica se é um booleano
  if (typeof valor === 'boolean') return valor;

  // Verifica se é uma string composta apenas por dígitos
  if (typeof valor === 'string' && /^\d+$/.test(valor)) {
    return Number(valor);
  }

  // Retorna o valor original em outros casos
  return valor;
}
