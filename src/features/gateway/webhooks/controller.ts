import { Body, Controller, Param, Post } from '@nestjs/common';
import { Public } from 'src/auth/decorators/public.decorator';
import { WebhooksService } from './service';

@Controller('webhooks')
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