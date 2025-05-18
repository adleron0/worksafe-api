export function ifBooleanParseBoolean(valor: any): any {
  // Verifica se já é um número
  if (typeof valor === 'boolean') return valor;

  // Verifica se é verdadeiro
  if (valor === 'true') {
    return true;
  }

  // Verifica se é falso
  if (valor === 'false') {
    return false;
  }

  // Retorna o valor original em outros casos
  return valor;
}
