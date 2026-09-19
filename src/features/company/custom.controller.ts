import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';

import { CompanyService } from './service';

/** Checklist de primeiros passos da empresa do ator (autenticada, sem permissão — como antes). */
@Controller('companies')
export class CompanyCustomController {
  constructor(private readonly companies: CompanyService) {}

  @Get('first-steps')
  async firstSteps(@Req() request: Request) {
    const v = await this.companies.validateFirstSteps(Number(request.user.companyId));
    return {
      ...v,
      allCompleted:
        v.hasCourse && v.hasInstructor && v.hasInstructorSignature &&
        v.hasCertificate && v.hasAsaasToken && v.hasClass,
    };
  }
}
