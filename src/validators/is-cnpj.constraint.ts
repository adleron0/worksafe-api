// src/validators/is-cnpj.constraint.ts
import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

/**
 * Remove tudo que não for dígito e retorna array de números
 */
function cleanCnpj(cnpj: string): number[] {
  return cnpj
    .replace(/\D+/g, '')
    .split('')
    .map((d) => parseInt(d, 10));
}

/**
 * Calcula um dígito verificador do CNPJ
 * @param numbers — array de números do CNPJ (12 para o 1º dígito, 13 para o 2º)
 * @param weights — pesos a aplicar (comprimento igual a numbers.length)
 */
function calcCnpjDigit(numbers: number[], weights: number[]): number {
  const sum = numbers.reduce((acc, num, idx) => acc + num * weights[idx], 0);
  const mod = sum % 11;
  return mod < 2 ? 0 : 11 - mod;
}

/**
 * Valida CNPJ pelo algoritmo oficial
 */
export function isValidCNPJ(cnpj: string): boolean {
  const nums = cleanCnpj(cnpj);
  if (nums.length !== 14) return false;
  // rejeita sequências iguais (ex: 00000000000000)
  if (nums.every((n) => n === nums[0])) return false;

  // pesos para o 1º dígito verificador (12 primeiros dígitos)
  const weights1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const digit1 = calcCnpjDigit(nums.slice(0, 12), weights1);
  if (digit1 !== nums[12]) return false;

  // pesos para o 2º dígito verificador (13 primeiros dígitos)
  const weights2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const digit2 = calcCnpjDigit(nums.slice(0, 13), weights2);
  return digit2 === nums[13];
}

@ValidatorConstraint({ async: false })
export class IsCnpjConstraint implements ValidatorConstraintInterface {
  validate(cnpj: any, _args: ValidationArguments) {
    return typeof cnpj === 'string' && isValidCNPJ(cnpj);
  }

  defaultMessage(_args: ValidationArguments) {
    return 'O CNPJ informado não é válido';
  }
}

/**
 * Decorator para usar no DTO
 */
export function IsCnpj(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsCnpjConstraint,
    });
  };
}
