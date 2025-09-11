import {
  gateways,
  paymentMethods,
  financialRecordsStatus,
  ContentType,
  LessonProgressStatus,
} from '@prisma/client';

/**
 * Interface para resposta da API de enums
 */
export interface EnumResponse<T = any> {
  success: boolean;
  data: T;
  message?: string;
  error?: string;
}

/**
 * Interface para todos os enums disponíveis
 */
export interface AllEnums {
  gateways: typeof gateways;
  paymentMethods: typeof paymentMethods;
  financialRecordsStatus: typeof financialRecordsStatus;
  ContentType: typeof ContentType;
  LessonProgressStatus: typeof LessonProgressStatus;
}

/**
 * Type para nomes de enums disponíveis
 */
export type EnumNames = keyof AllEnums;

/**
 * Interface para resposta com todos os enums
 */
export interface AllEnumsResponse extends EnumResponse<AllEnums> {
  count: number;
}

/**
 * Interface para resposta com nomes dos enums
 */
export interface EnumNamesResponse extends EnumResponse<string[]> {
  count: number;
}

/**
 * Interface para resposta de um enum específico
 */
export interface SingleEnumResponse extends EnumResponse {
  name: string;
}
