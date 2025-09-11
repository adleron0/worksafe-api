import {
  IsOptional,
  IsObject,
  IsNumber,
  IsArray,
  IsString,
  IsEnum,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

// Tipos de conteúdo
enum ContentType {
  VIDEO = 'VIDEO',
  TEXT = 'TEXT',
  QUIZ = 'QUIZ',
}

// DTO para resposta de quiz
class QuizAnswerDto {
  @IsNumber()
  questionId: number;

  @IsOptional()
  @IsArray()
  selectedOptions?: number[]; // Para múltipla escolha

  @IsOptional()
  @IsString()
  textAnswer?: string; // Para questões abertas
}

// DTO para dados de progresso de vídeo
class VideoProgressDto {
  @IsNumber()
  watchedSeconds: number;

  @IsNumber()
  totalDuration: number;

  @IsOptional()
  @IsNumber()
  lastPosition?: number;
}

// DTO para dados de progresso de texto
class TextProgressDto {
  @IsOptional()
  @IsNumber()
  readingTime?: number; // em segundos

  @IsOptional()
  @IsNumber()
  scrollPercentage?: number; // 0-100
}

// DTO para dados de progresso de quiz
class QuizProgressDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuizAnswerDto)
  responses: QuizAnswerDto[];

  @IsNumber()
  timeSpent: number; // em segundos
}

export class CompleteDto {
  @IsOptional()
  @IsEnum(ContentType)
  @Transform(({ value }) => {
    // Garantir que contentType seja string se vier como JSON
    if (typeof value === 'string') {
      return value.toUpperCase();
    }
    return value;
  })
  contentType?: ContentType;

  @IsOptional()
  @Transform(
    ({ value }) => {
      // Aceitar tanto string JSON quanto objeto
      console.log('DTO Transform - progressData recebido:', value);
      console.log('DTO Transform - tipo:', typeof value);

      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          console.log('DTO Transform - parsed:', parsed);
          return parsed;
        } catch (error) {
          console.error('Erro ao fazer parse do progressData:', error);
          return {};
        }
      }
      return value || {};
    },
    { toClassOnly: true },
  )
  @IsObject()
  progressData?: VideoProgressDto | TextProgressDto | QuizProgressDto | any;
}
