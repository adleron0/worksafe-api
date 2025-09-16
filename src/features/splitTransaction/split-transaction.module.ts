import { Module } from '@nestjs/common';
import { SplitTransactionService } from './split-transaction.service';

@Module({
  providers: [SplitTransactionService],
  exports: [SplitTransactionService],
})
export class SplitTransactionModule {}