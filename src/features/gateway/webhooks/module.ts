import { Module } from '@nestjs/common';
import { WebhooksController } from './controller';
import { WebhooksService } from './service';

@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}