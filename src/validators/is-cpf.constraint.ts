// src/validators/is-cpf.constraint.ts
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
function cleanCpf(cpf: string): number[] {
  return cpf
    .replace(/\D+/g, '')
    .split('')
    .map((d) => parseInt(d, 10));
}

/**
 * Calcula um dígito verificador do CPF
 * @param numbers — os dígitos do CPF a considerar
 * @returns o dígito (0–9)
 */
function calcVerifierDigit(numbers: number[]): number {
  let sum = 0;
  const factor = numbers.length + 1;
  for (let i = 0; i < numbers.length; i++) {
    sum += numbers[i] * (factor - i);
  }
  const mod = sum % 11;
  return mod < 2 ? 0 : 11 - mod;
}

/**
 * Valida CPF pelo algoritmo de dígitos verificadores
 */
export function isValidCPF(cpf: string): boolean {
  const nums = cleanCpf(cpf);
  if (nums.length !== 11) return false;
  // rejeita CPF com todos dígitos iguais (ex: 00000000000)
  if (nums.every((d) => d === nums[0])) return false;

  // calcula 1º dígito e compara
  const digit1 = calcVerifierDigit(nums.slice(0, 9));
  if (digit1 !== nums[9]) return false;

  // calcula 2º dígito e compara
  const digit2 = calcVerifierDigit(nums.slice(0, 10));
  return digit2 === nums[10];
}

@ValidatorConstraint({ async: false })
export class IsCpfConstraint implements ValidatorConstraintInterface {
  validate(cpf: any, _args: ValidationArguments) {
    return typeof cpf === 'string' && isValidCPF(cpf);
  }

  defaultMessage(_args: ValidationArguments) {
    return 'O CPF informado não é válido';
  }
}

/**
 * Decorator para usar no DTO
 */
export function IsCpf(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsCpfConstraint,
    });
  };
}
