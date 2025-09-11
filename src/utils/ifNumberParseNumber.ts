export function ifNumberParseNumber(valor: any): any {
  // Verifica se já é um número
  if (typeof valor === 'number') return valor;

  // Verifica se é um booleano
  if (typeof valor === 'boolean') return valor;

  // Verifica se é um objeto (mas não array)
  if (typeof valor === 'object' && !Array.isArray(valor)) return valor;

  // Valor é null ou undefined ou array
  if (!valor || Array.isArray(valor)) return valor;

  // Verifica se é string antes de chamar métodos de string
  if (typeof valor !== 'string') return valor;

  // se começar com 0 ou tiver ponto, trata como string
  if (valor.startsWith('0') || valor.includes('.') || valor.includes(',')) {
    return valor;
  }

  const num = Number(valor);
  const result = isNaN(num) ? valor : num;

  return result;
}
