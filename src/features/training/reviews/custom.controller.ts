import { Body, Controller, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { Public } from 'src/auth/decorators/public.decorator';
import { CacheEvictAll } from 'src/common/cache';
import { PublicFormFields } from '../public-form';
import { ReviewsService } from './service';

/** Aluno avalia a turma sem login (validado pela inscrição confirmada, no service). */
@Controller('reviews')
export class ReviewsCustomController {
  constructor(private readonly reviews: ReviewsService) {}

  @Public()
  @Post('create-review')
  @CacheEvictAll('training-classes:*', 'cache:*/classes*')
  // multipart do front, sem arquivo (a avaliação nunca usou upload)
  @PublicFormFields()
  createReview(@Req() request: Request, @Body() dto: Record<string, any>) {
    const search = {
      companyId: dto.companyId || request.user?.companyId,
      classId: dto.classId,
      traineeId: dto.traineeId,
    };
    return this.reviews.createReview(
      search,
      { model: 'courseReview', name: 'Avaliação' },
      dto,
    );
  }
}
