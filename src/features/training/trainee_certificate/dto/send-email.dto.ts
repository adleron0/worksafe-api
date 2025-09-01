import { IsNotEmpty, IsNumber, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

export class SendCertificateEmailDto {
  @IsNotEmpty()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  traineeId: number;

  @IsNotEmpty()
  @IsString()
  certificateKey: string;
}