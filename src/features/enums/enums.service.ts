import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

@Injectable()
export class EnumsService {
  /**
   * Retorna todos os enums disponíveis no Prisma Client
   */
  getAllEnums(): Record<string, any> {
    const enums: Record<string, any> = {};
    
    // Lista de enums conhecidos do Prisma
    // Precisamos listar explicitamente pois o Prisma não exporta uma lista de enums
    const enumNames = [
      'gateways',
      'paymentMethods',
      'financialRecordsStatus',
      'ContentType',
      'LessonProgressStatus'
    ];
    
    // Extrai cada enum do namespace Prisma
    enumNames.forEach(enumName => {
      if (enumName in Prisma) {
        enums[enumName] = (Prisma as any)[enumName];
      }
    });
    
    return enums;
  }

  /**
   * Busca um enum específico pelo nome
   */
  getEnumByName(enumName: string): any {
    // Verifica se o enum existe no Prisma
    if (!(enumName in Prisma)) {
      throw new Error(`Enum '${enumName}' não encontrado`);
    }
    
    const enumValue = (Prisma as any)[enumName];
    
    // Verifica se é realmente um enum (objeto com valores string/number)
    if (!this.isValidEnum(enumValue)) {
      throw new Error(`'${enumName}' não é um enum válido`);
    }
    
    return enumValue;
  }

  /**
   * Lista todos os nomes de enums disponíveis
   */
  getEnumNames(): string[] {
    const enums = this.getAllEnums();
    return Object.keys(enums);
  }

  /**
   * Verifica se um objeto é um enum válido
   */
  private isValidEnum(obj: any): boolean {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return false;
    }
    
    // Verifica se todos os valores são strings ou números
    const values = Object.values(obj);
    return values.length > 0 && values.every(val => 
      typeof val === 'string' || typeof val === 'number'
    );
  }
}