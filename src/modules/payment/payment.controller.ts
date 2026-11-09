import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { GatewayAuthGuard } from '../../common/guards/gateway-auth.guard';
import type { AuthenticatedRequest } from '../../common/interfaces/request-context.interface';
import { CreatePaymentQrDto } from './dto/create-payment-qr.dto';
import { PaymentHistoryQueryDto } from './dto/payment-history-query.dto';
import { ReleaseLinksDto } from './dto/release-links.dto';
import { PaymentService } from './payment.service';

/**
 * Thanh toán đơn căn tin qua PayOS: Gateway tạo link/QR sau khi đã đối chiếu đơn với Canteen,
 * người dùng tra cứu trạng thái và lịch sử thanh toán của mình.
 */
@Controller('api/payment')
@UseGuards(GatewayAuthGuard)
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('create-qr')
  createQr(
    @Body() body: CreatePaymentQrDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.paymentService.createQr(body, request.user);
  }

  /** Chữ ký Gateway gắn mã đơn và lý do (GatewayAuthGuard), thay cho kiểm quyền theo người gọi. */
  @Post('orders/:orderId/release-links')
  @HttpCode(200)
  releaseOrderLinks(
    @Param('orderId') orderId: string,
    @Body() body: ReleaseLinksDto,
  ) {
    return this.paymentService.releaseOrderLinks(orderId, body.reason);
  }

  @Get('history')
  getHistory(
    @Query() query: PaymentHistoryQueryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.paymentService.getHistory(request.user, query.limit);
  }

  @Get('orders/:orderId')
  getLatestForOrder(
    @Param('orderId') orderId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.paymentService.getLatestForOrder(orderId, request.user);
  }

  @Get('payments/:paymentId')
  getPayment(
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.paymentService.getPayment(paymentId, request.user);
  }
}
