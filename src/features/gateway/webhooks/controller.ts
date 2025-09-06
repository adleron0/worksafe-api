import { Body, Controller, Param, Post } from '@nestjs/common';
import { Public } from 'src/auth/decorators/public.decorator';
import { SkipThrottle } from '@nestjs/throttler';
import { WebhooksService } from './service';

@Controller('webhooks')
@SkipThrottle() // Ignora rate limiting para webhooks
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Public()
  @Post(':gateway/:companyId')
  async registerWebhook(
    @Param('gateway') gateway: string,
    @Param('companyId') companyId: string,
    @Body() payload: any,
  ) {
    return this.webhooksService.registerWebhook(
      gateway,
      Number(companyId),
      payload,
    );
  }
}
