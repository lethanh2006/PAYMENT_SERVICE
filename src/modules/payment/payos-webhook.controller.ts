import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';

import type { AuthenticatedRequest } from '../../common/interfaces/request-context.interface';
import { PaymentService } from './payment.service';

/**
 * Nhận webhook PayOS báo link đã được thanh toán; Gateway chuyển tiếp nguyên body, xác
 * thực bằng checksum key của PayOS chứ không bằng chữ ký Gateway.
 */
@Controller()
export class PayosWebhookController {
  constructor(private readonly paymentService: PaymentService) {}

  /** Luôn trả 200 cho giao dịch hợp lệ chữ ký, kể cả cần đối soát, để PayOS không gửi lại. */
  @Post('api/payment/webhooks/payos')
  @HttpCode(200)
  async handle(@Body() payload: unknown, @Req() request: AuthenticatedRequest) {
    const result = await this.paymentService.handlePayosWebhook(
      payload,
      request.requestId,
    );
    return {
      success: true,
      processed: result.outcome === 'PROCESSED' ? 1 : 0,
      duplicate: result.outcome === 'DUPLICATE' ? 1 : 0,
      reviewRequired: result.outcome === 'REVIEW_REQUIRED' ? 1 : 0,
    };
  }
}
