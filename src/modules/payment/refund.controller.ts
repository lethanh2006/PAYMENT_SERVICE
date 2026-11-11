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
import { RefundQueryDto } from './dto/refund-query.dto';
import { ResolveRefundDto } from './dto/resolve-refund.dto';
import { RefundService } from './refund.service';

/** Hàng hồ sơ hoàn tiền cho nhân viên căn tin (admin, manager, cashier), qua Gateway. */
@Controller('api/payment/refunds')
@UseGuards(GatewayAuthGuard)
export class RefundController {
  constructor(private readonly refundService: RefundService) {}

  @Get()
  list(@Query() query: RefundQueryDto, @Req() request: AuthenticatedRequest) {
    return this.refundService.list(query, request.user);
  }

  /** Chữ ký Gateway gắn mã hồ sơ và kết quả (GatewayAuthGuard). */
  @Post(':caseId/resolve')
  @HttpCode(200)
  resolve(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @Body() body: ResolveRefundDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.refundService.resolve(caseId, body, request.user);
  }
}
