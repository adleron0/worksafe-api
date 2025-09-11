import { Module } from '@nestjs/common';
import { EnumsController } from './enums.controller';
import { EnumsService } from './enums.service';

@Module({
  controllers: [EnumsController],
  providers: [EnumsService],
  exports: [EnumsService],
})
export class EnumsModule {}
