import { Controller, Post, Req, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';

import { Public } from 'src/auth/decorators/public.decorator';
import { CouponService } from './service';

/** Validação pública de cupom no checkout — rota custom, fora da fábrica. */
@Controller('coupon')
export class CouponValidateController {
  constructor(private readonly service: CouponService) {}

  @Public()
  @Post('validate')
  @UseInterceptors(FileInterceptor('file'))
  validate(@Req() request: Request) {
    const { cpf, code, classId } = request.body;
    const classIdNumber = typeof classId === 'string' ? parseInt(classId, 10) : classId;
    // Rota pública não retorna dados de comissão (internal = false)
    return this.service.validateCoupon(cpf, code, classIdNumber, false);
  }
}
