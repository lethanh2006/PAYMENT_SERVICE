import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/interfaces/request-context.interface';
import { appLogger } from '../../common/logging/logger';
import { userIdOf } from '../../common/utils/user.util';
import { UnprocessableMessage } from '../rabbitmq/rabbitmq.service';
import type { RefundQueryDto } from './dto/refund-query.dto';
import type { ResolveRefundDto } from './dto/resolve-refund.dto';
import { type RefundCase, RefundRepository } from './refund.repository';

const STAFF_ROLES = new Set(['admin', 'manager', 'cashier']);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RefundCaseResponse {
  refundId: string;
  paymentId: string | null;
  orderId: string | null;
  providerEventId: string;
  amount: number;
  reason: string;
  source: RefundCase['source'];
  status: RefundCase['status'];
  resolvedBy: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

/**
 * Bước bù của saga thanh toán: mở hồ sơ hoàn tiền khi Canteen không áp được tiền vào đơn, và cho
 * nhân viên (admin, manager, cashier) xem rồi chốt đã hoàn tiền hoặc bỏ qua, mỗi hồ sơ đúng một lần.
 */
@Injectable()
export class RefundService {
  constructor(private readonly refunds: RefundRepository) {}

  async list(
    query: RefundQueryDto,
    user: AuthenticatedUser | undefined,
  ): Promise<RefundCaseResponse[]> {
    this.assertStaff(user);
    const cases = await this.refunds.list(query.status, query.limit);
    return cases.map(toResponse);
  }

  async resolve(
    caseId: string,
    dto: ResolveRefundDto,
    user: AuthenticatedUser | undefined,
  ): Promise<RefundCaseResponse> {
    const staffId = this.assertStaff(user);
    const result = await this.refunds.resolve(
      caseId,
      dto.outcome,
      staffId,
      dto.note?.trim() || null,
    );
    if (result.outcome === 'NOT_FOUND') {
      throw new NotFoundException('Không tìm thấy hồ sơ hoàn tiền');
    }
    if (result.outcome === 'ALREADY_RESOLVED') {
      throw new ConflictException(
        `Hồ sơ đã được chốt ${result.refundCase.status} trước đó`,
      );
    }
    appLogger.info(
      {
        'event.name': 'payment.refund.resolved',
        'refund.id': result.refundCase.id,
        'refund.status': result.refundCase.status,
        'payment.id': result.refundCase.paymentId,
        'user.id': staffId,
      },
      'Nhân viên đã chốt hồ sơ hoàn tiền',
    );
    return toResponse(result.refundCase);
  }

  /** Nhận `canteen.payment.unapplied.v1`; message sai cấu trúc hoặc payment lạ thì vào hàng dead. */
  async recordUnapplied(message: unknown): Promise<void> {
    const data =
      isRecord(message) && message.eventType === 'canteen.payment.unapplied.v1'
        ? message.data
        : undefined;
    if (!isRecord(data)) {
      throw new UnprocessableMessage('Sự kiện Canteen sai định dạng');
    }
    const { paymentId, reason } = data;
    if (typeof paymentId !== 'string' || !UUID_PATTERN.test(paymentId)) {
      throw new UnprocessableMessage('Sự kiện Canteen thiếu paymentId hợp lệ');
    }
    const text =
      typeof reason === 'string' && reason.trim()
        ? reason.trim()
        : 'Canteen không áp được thanh toán vào đơn';

    const outcome = await this.refunds.openForUnappliedPayment(paymentId, text);
    if (outcome === 'UNKNOWN_PAYMENT') {
      throw new UnprocessableMessage(`Không có payment ${paymentId}`);
    }
    const fields = { 'payment.id': paymentId, 'refund.outcome': outcome };
    if (outcome === 'OPENED') {
      appLogger.warn(
        { 'event.name': 'payment.refund.opened', ...fields },
        'Mở hồ sơ hoàn tiền vì Canteen không áp được thanh toán vào đơn',
      );
    } else {
      appLogger.info(
        { 'event.name': 'payment.refund.skipped', ...fields },
        'Sự kiện Canteen trùng hoặc payment đã hoàn tiền, không mở thêm hồ sơ',
      );
    }
  }

  private assertStaff(user: AuthenticatedUser | undefined): string {
    const userId = userIdOf(user);
    if (!userId || !STAFF_ROLES.has(user?.role?.toLowerCase() ?? '')) {
      throw new ForbiddenException(
        'Chỉ admin, quản lý hoặc thu ngân được xử lý hoàn tiền',
      );
    }
    return userId;
  }
}

function toResponse(refundCase: RefundCase): RefundCaseResponse {
  return {
    refundId: refundCase.id,
    paymentId: refundCase.paymentId,
    orderId: refundCase.orderId,
    providerEventId: refundCase.providerEventId,
    amount: refundCase.amount,
    reason: refundCase.reason,
    source: refundCase.source,
    status: refundCase.status,
    resolvedBy: refundCase.resolvedBy,
    resolutionNote: refundCase.resolutionNote,
    resolvedAt: refundCase.resolvedAt?.toISOString() ?? null,
    createdAt: refundCase.createdAt.toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
