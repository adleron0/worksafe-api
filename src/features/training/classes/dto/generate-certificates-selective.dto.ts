import { IsArray, IsInt, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO para geração seletiva de certificados
 * Permite escolher quais inscrições terão certificados gerados
 */
export class GenerateCertificatesSelectiveDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Deve haver pelo menos 1 subscriptionId' })
  @IsInt({ each: true })
  @Type(() => Number)
  subscriptionIds: number[];
}
