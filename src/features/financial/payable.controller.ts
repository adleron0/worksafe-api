import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { Permissions } from 'src/auth/decorators/permissions.decorator';
import { getDocumentMulterOptions } from 'src/features/upload/upload.middleware';
import { PayableActor, PayableService } from './payable.service';

const actorOf = (req: Request): PayableActor => {
  const user = (req as Request & { user?: { sub?: number; companyId?: number } }).user;
  return { userId: Number(user?.sub ?? 0), companyId: Number(user?.companyId ?? 0) };
};

/** Contas a pagar: o que não é cadastro simples (parcelas, baixa, estorno, resumo). */
@Controller()
export class PayableController {
  constructor(private readonly payables: PayableService) {}

  @Permissions('list_financeiro') @Get('financial/payables-summary')
  summary(@Req() req: Request, @Query('month') month?: string) {
    return this.payables.summary(actorOf(req).companyId, month || undefined);
  }

  @Permissions('create_financeiro') @Post('financial-payables/installments')
  installments(@Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.payables.createInstallments(actorOf(req), body ?? {});
  }

  @Permissions('update_financeiro') @Patch('financial-payables/settle/:id')
  @UseInterceptors(FileInterceptor('receiptFile', getDocumentMulterOptions('financial-payables')))
  settle(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Record<string, unknown>, @UploadedFile() file?: Express.MulterS3.File) {
    return this.payables.settle(id, body ?? {}, actorOf(req), file?.location ?? null);
  }

  @Permissions('update_financeiro') @Patch('financial-payables/unsettle/:id')
  unsettle(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.payables.unsettle(id, body ?? {}, actorOf(req));
  }
}
