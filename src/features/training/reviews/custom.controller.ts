import { Body, Controller, Post, Req, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { Public } from 'src/auth/decorators/public.decorator';
import { CacheEvictAll } from 'src/common/cache';
import { getMulterOptions } from 'src/features/upload/upload.middleware';
import { ReviewsService } from './service';

/** Aluno avalia a turma sem login (validado pela inscrição confirmada, no service). */
@Controller('reviews')
export class ReviewsCustomController {
  constructor(private readonly reviews: ReviewsService) {}

  @Public() @Post('create-review')
  @CacheEvictAll('training-classes:*', 'cache:*/classes*')
  @UseInterceptors(FileInterceptor('image', getMulterOptions('reviews-image')))
  createReview(@Req() request: Request, @Body() dto: Record<string, any>) {
    const search = { companyId: dto.companyId || request.user?.companyId, classId: dto.classId, traineeId: dto.traineeId };
    return this.reviews.createReview(search, { model: 'courseReview', name: 'Avaliação' }, dto);
  }
}
