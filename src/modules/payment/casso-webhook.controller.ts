import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../../common/interfaces/request-context.interface';
import { PaymentService } from './payment.service';

@Controller()
export class CassoWebhookController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post(['webhook/casso', 'api/payment/webhooks/casso', 'api/payment/callback'])
  @HttpCode(200)
  async handle(
    @Body() payload: unknown,
    @Headers('x-casso-signature') signature: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const results = await this.paymentService.handleCassoWebhook(
      payload,
      signature,
      request.requestId,
    );
    return {
      success: true,
      processed: results.filter((result) => result.outcome === 'PROCESSED')
        .length,
      duplicate: results.filter((result) => result.outcome === 'DUPLICATE')
        .length,
      reviewRequired: results.filter(
        (result) => result.outcome === 'REVIEW_REQUIRED',
      ).length,
    };
  }
}
