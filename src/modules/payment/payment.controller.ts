import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../../common/interfaces/request-context.interface';
import { GatewayAuthGuard } from '../../common/guards/gateway-auth.guard';
import { CreatePaymentQrDto } from './dto/create-payment-qr.dto';
import { PaymentHistoryQueryDto } from './dto/payment-history-query.dto';
import { PaymentService } from './payment.service';

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
