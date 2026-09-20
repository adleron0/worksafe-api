import { Controller, Get, Param } from '@nestjs/common';
import { Public } from 'src/auth/decorators/public.decorator';
import { FinancialrecordsService } from './service';

/** Consulta pública de um registro pela key (UUID) — usada no checkout/boleto. */
@Controller('financial-records')
export class FinancialRecordsCustomController {
  constructor(private readonly records: FinancialrecordsService) {}
  @Public() @Get('key/:key')
  byKey(@Param('key') key: string) {
    return this.records.getFinancialRecordByKey(key);
  }
}
