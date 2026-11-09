import { createHash, randomInt, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { logException } from '@nrapp/observability';

import type { AuthenticatedUser } from '../../common/interfaces/request-context.interface';
import type { ReleaseReason } from '../../common/security/payment-request-context';
import { appLogger } from '../../common/logging/logger';
import { userIdOf } from '../../common/utils/user.util';
import {
  PaymentEntity,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
} from '../../database/entities/payment.entity';
import type { CreatePaymentQrDto } from './dto/create-payment-qr.dto';
import {
  OrderPaymentClosedError,
  PaymentRepository,
  type WebhookProcessingResult,
} from './payment.repository';
import { payosDataString } from './payos-signature';
import { PayosClient } from './payos.client';

// Tài khoản ngân hàng chưa liên kết qua PayOS chỉ nhận nội dung chuyển khoản tối đa 9 ký tự.
const MAX_DESCRIPTION_LENGTH = 9;
// PayOS gửi thời gian giao dịch theo giờ Việt Nam, không kèm múi giờ.
const PAYOS_TIMEZONE_OFFSET = '+07:00';

const ORDER_CLOSED_MESSAGE = 'Đơn hàng không còn nhận thanh toán online';
const CLOSE_REASON_TEXT: Record<ReleaseReason, string> = {
  ORDER_CANCELLED: 'Đơn hàng đã huỷ',
  PAID_IN_CASH: 'Đơn hàng đã thanh toán tiền mặt',
};

/** Một lần tiền về trên link PayOS, đến từ webhook hoặc từ đối soát. */
export interface PayosTransactionData {
  orderCode: unknown;
  paymentLinkId: unknown;
  reference: unknown;
  amount: unknown;
  transactionDateTime: unknown;
  counterAccountBankName?: unknown;
  counterAccountName?: unknown;
}

export interface PaymentResponse {
  paymentId: string;
  orderId: string;
  orderCode: number;
  amount: number;
  currency: string;
  status: PaymentStatus;
  paymentMethod: PaymentMethod;
  checkoutUrl: string | null;
  qrCode: string;
  description: string;
  expiresAt: string;
  paidAt: string | null;
  createdAt: string;
}

@Injectable()
export class PaymentService {
  private readonly intentTtlMs: number;
  private readonly paymentCodePrefix: string;

  constructor(
    private readonly payments: PaymentRepository,
    private readonly payosClient: PayosClient,
    configService: ConfigService,
  ) {
    const ttlMinutes = Number(
      configService.get<string>('PAYMENT_INTENT_TTL_MINUTES') ?? 15,
    );
    if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes <= 0) {
      throw new Error('PAYMENT_INTENT_TTL_MINUTES phải là số nguyên dương');
    }
    this.intentTtlMs = ttlMinutes * 60_000;

    const prefix = (configService.get<string>('PAYMENT_CODE_PREFIX') ?? 'NRP')
      .trim()
      .toUpperCase();
    if (!/^[A-Z0-9]{2,6}$/.test(prefix)) {
      throw new Error(
        'PAYMENT_CODE_PREFIX chỉ được gồm 2-6 ký tự A-Z hoặc 0-9',
      );
    }
    this.paymentCodePrefix = prefix;
  }

  async createQr(
    dto: CreatePaymentQrDto,
    user: AuthenticatedUser | undefined,
  ): Promise<PaymentResponse> {
    this.assertCanCreateForOrder(dto.orderUserId, user);
    // Kiểm sớm để khỏi tạo link PayOS vô ích; createOrReuse kiểm lại dưới khoá mới là chốt chặn thật.
    if (await this.payments.findClosure(dto.orderId)) {
      throw new ConflictException(ORDER_CLOSED_MESSAGE);
    }
    const active = await this.payments.findActiveForOrder(dto.orderId);
    if (
      active &&
      (active.status === PaymentStatus.SUCCESS ||
        (active.amount === dto.amount && active.userId === dto.orderUserId))
    ) {
      this.assertCanRead(active, user);
      return this.toResponse(active);
    }

    const orderCode = this.nextOrderCode();
    const description = this.describe(orderCode);
    const expiresAt = new Date(Date.now() + this.intentTtlMs);
    const link = await this.payosClient.createPaymentLink({
      orderCode,
      amount: dto.amount,
      description,
      expiresAt,
    });

    const candidate = new PaymentEntity();
    Object.assign(candidate, {
      id: randomUUID(),
      orderId: dto.orderId,
      userId: dto.orderUserId,
      paymentCode: String(orderCode),
      amount: dto.amount,
      currency: 'VND',
      status: PaymentStatus.PENDING,
      paymentMethod: PaymentMethod.PAYOS,
      provider: PaymentProvider.PAYOS,
      transferDescription: description,
      qrCode: link.qrCode,
      checkoutUrl: link.checkoutUrl,
      paymentLinkId: link.paymentLinkId,
      destinationAccount: link.accountNumber,
      providerTransactionId: null,
      providerReference: null,
      providerMetadata: null,
      reviewReason: null,
      expiresAt,
      paidAt: null,
      providerStatus: null,
      reconciledAt: null,
    });

    let created: Awaited<ReturnType<PaymentRepository['createOrReuse']>>;
    try {
      created = await this.payments.createOrReuse(candidate);
    } catch (error: unknown) {
      if (error instanceof OrderPaymentClosedError) {
        // Đơn vừa bị huỷ hoặc thu tiền mặt trong lúc chờ PayOS: khoá link vừa tạo.
        void this.cancelLink(
          link.paymentLinkId,
          CLOSE_REASON_TEXT[error.reason],
        );
        throw new ConflictException(ORDER_CLOSED_MESSAGE);
      }
      throw error;
    }
    const { payment, supersededLinkId } = created;
    if (payment.id !== candidate.id) {
      // Request song song đã tạo link khác cho đơn này; huỷ link thừa để khách không trả nhầm.
      void this.cancelLink(
        link.paymentLinkId,
        'Đơn hàng đã có link thanh toán khác',
      );
    }
    if (supersededLinkId) {
      // Link cũ còn hạn nhưng đơn đã đổi số tiền hoặc chủ đơn: khoá nó để khách không trả theo link cũ.
      void this.cancelLink(supersededLinkId, 'Link đã được thay bằng link mới');
    }
    this.assertCanRead(payment, user);
    return this.toResponse(payment);
  }

  /**
   * Đơn đã huỷ hoặc đã thu tiền mặt: đóng thanh toán online và huỷ mọi link còn mở phía PayOS,
   * để khách không trả thêm qua mã QR cũ. Gateway chỉ gọi sau khi Canteen đã chấp nhận thao tác.
   */
  async releaseOrderLinks(
    orderId: string,
    reason: ReleaseReason,
  ): Promise<{ cancelledLinks: number }> {
    if (!/^[a-f0-9]{24}$/i.test(orderId)) {
      throw new BadRequestException('orderId không hợp lệ');
    }
    const linkIds = await this.payments.closeOrder(orderId, reason);
    await Promise.all(
      linkIds.map((linkId) =>
        this.cancelLink(linkId, CLOSE_REASON_TEXT[reason]),
      ),
    );
    return { cancelledLinks: linkIds.length };
  }

  async getPayment(
    paymentId: string,
    user: AuthenticatedUser | undefined,
  ): Promise<PaymentResponse> {
    const payment = await this.payments.findById(paymentId);
    if (!payment) {
      throw new NotFoundException('Không tìm thấy giao dịch thanh toán');
    }
    this.assertCanRead(payment, user);
    return this.toResponse(payment);
  }

  async getLatestForOrder(
    orderId: string,
    user: AuthenticatedUser | undefined,
  ): Promise<PaymentResponse> {
    const payment = await this.payments.findLatestByOrder(orderId);
    if (!payment) {
      throw new NotFoundException('Đơn hàng chưa có giao dịch thanh toán');
    }
    this.assertCanRead(payment, user);
    return this.toResponse(payment);
  }

  async getHistory(
    user: AuthenticatedUser | undefined,
    limit: number,
  ): Promise<PaymentResponse[]> {
    const userId = this.requireUserId(user);
    const payments = await this.payments.findHistory(userId, limit);
    return payments.map((payment) => this.toResponse(payment));
  }

  async handlePayosWebhook(
    payload: unknown,
    requestId: string | undefined,
  ): Promise<WebhookProcessingResult> {
    const data = this.payosClient.verifyWebhook(payload);
    if (!data) {
      throw new BadRequestException('Chữ ký PayOS không hợp lệ');
    }
    const succeeded =
      (payload as Record<string, unknown>).code === '00' && data.code === '00';

    return this.recordPayosTransaction(
      {
        orderCode: data.orderCode,
        paymentLinkId: data.paymentLinkId,
        reference: data.reference,
        amount: data.amount,
        transactionDateTime: data.transactionDateTime,
        counterAccountBankName: data.counterAccountBankName,
        counterAccountName: data.counterAccountName,
      },
      succeeded ? null : 'PayOS báo giao dịch không thành công',
      requestId ?? null,
    );
  }

  /**
   * Ghi một lần tiền về, từ webhook hay từ đối soát, qua cùng một đường idempotent: mã sự kiện
   * `<paymentLinkId>:<reference>` giống nhau ở hai nguồn, nên giao dịch nào cũng chỉ được ghi một lần.
   */
  async recordPayosTransaction(
    transaction: PayosTransactionData,
    providerValidationError: string | null,
    requestId: string | null,
  ): Promise<WebhookProcessingResult> {
    const { orderCode, amount } = transaction;
    if (!Number.isSafeInteger(orderCode) || (orderCode as number) <= 0) {
      throw new BadRequestException('orderCode PayOS không hợp lệ');
    }
    if (!Number.isSafeInteger(amount) || (amount as number) <= 0) {
      throw new BadRequestException('Số tiền PayOS không hợp lệ');
    }
    const reference = text(transaction.reference, 160);
    const paymentLinkId = text(transaction.paymentLinkId, 64);
    const transactionDateTime = text(transaction.transactionDateTime, 64);
    const counterAccountBankName = text(transaction.counterAccountBankName, 80);
    const counterAccountName = text(transaction.counterAccountName, 80);

    return this.payments.processPayosTransaction({
      providerEventId:
        `${paymentLinkId ?? ''}:${reference ?? String(orderCode)}`.slice(
          0,
          128,
        ),
      paymentCode: String(orderCode),
      amount: amount as number,
      providerReference: reference,
      // Băm các trường cốt lõi mà webhook và API tra cứu đều có, để cùng giao dịch cho cùng mã băm.
      payloadHash: createHash('sha256')
        .update(
          payosDataString({
            amount,
            orderCode,
            paymentLinkId,
            reference,
            transactionDateTime,
          }),
          'utf8',
        )
        .digest('hex'),
      metadata: {
        ...(paymentLinkId ? { paymentLinkId } : {}),
        ...(transactionDateTime ? { transactionDateTime } : {}),
        ...(counterAccountBankName ? { counterAccountBankName } : {}),
        ...(counterAccountName ? { counterAccountName } : {}),
      },
      paidAt: parsePayosDate(transactionDateTime) ?? new Date(),
      providerValidationError,
      requestId,
    });
  }

  /** Số nguyên duy nhất PayOS yêu cầu cho mỗi link: giây hiện tại ghép 5 chữ số ngẫu nhiên. */
  private nextOrderCode(): number {
    return Math.floor(Date.now() / 1000) * 100_000 + randomInt(100_000);
  }

  private describe(orderCode: number): string {
    const tail = String(orderCode).slice(
      -(MAX_DESCRIPTION_LENGTH - this.paymentCodePrefix.length),
    );
    return `${this.paymentCodePrefix}${tail}`;
  }

  private async cancelLink(
    paymentLinkId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.payosClient.cancelPaymentLink(paymentLinkId, reason);
    } catch (error: unknown) {
      logException(
        appLogger,
        'payment.payos.cancel.failed',
        error,
        { 'payment.link_id': paymentLinkId },
        {
          message: 'Không huỷ được link PayOS thừa',
          classification: {
            statusCode: 502,
            code: 'PAYOS_CANCEL_FAILED',
            expected: true,
            retryable: true,
            logLevel: 'warn',
          },
        },
      );
    }
  }

  private requireUserId(user: AuthenticatedUser | undefined): string {
    const userId = userIdOf(user);
    if (!userId) {
      throw new ForbiddenException('Không xác định được người dùng thanh toán');
    }
    return userId;
  }

  private assertCanCreateForOrder(
    orderUserId: string,
    user: AuthenticatedUser | undefined,
  ): void {
    const actorUserId = this.requireUserId(user);
    const elevatedRoles = new Set(['admin', 'manager', 'cashier']);
    if (
      actorUserId !== orderUserId &&
      !elevatedRoles.has(user?.role?.toLowerCase() ?? '')
    ) {
      throw new ForbiddenException(
        'Bạn không có quyền tạo thanh toán cho đơn hàng này',
      );
    }
  }

  private assertCanRead(
    payment: PaymentEntity,
    user: AuthenticatedUser | undefined,
  ): void {
    const userId = this.requireUserId(user);
    const elevatedRoles = new Set(['admin', 'manager', 'cashier']);
    if (
      payment.userId !== userId &&
      !elevatedRoles.has(user?.role?.toLowerCase() ?? '')
    ) {
      throw new ForbiddenException('Bạn không có quyền xem thanh toán này');
    }
  }

  private toResponse(payment: PaymentEntity): PaymentResponse {
    return {
      paymentId: payment.id,
      orderId: payment.orderId,
      orderCode: Number(payment.paymentCode),
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      paymentMethod: payment.paymentMethod,
      checkoutUrl: payment.checkoutUrl,
      qrCode: payment.qrCode,
      description: payment.transferDescription,
      expiresAt: payment.expiresAt.toISOString(),
      paidAt: payment.paidAt?.toISOString() ?? null,
      createdAt: payment.createdAt.toISOString(),
    };
  }
}

function text(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maxLength)
    : null;
}

/** `2026-11-04 10:15:00` theo giờ Việt Nam; `null` nếu sai định dạng hoặc sai lịch. */
export function parsePayosDate(value: string | null): Date | null {
  const match = value?.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!match) {
    return null;
  }
  const parsed = new Date(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${PAYOS_TIMEZONE_OFFSET}`,
  );
  if (
    Number.isNaN(parsed.getTime()) ||
    // Date tự cuộn ngày sai lịch (30/02 -> 02/03); so lại để bắt trường hợp đó.
    new Date(parsed.getTime() + 7 * 3_600_000).getUTCDate() !== Number(match[3])
  ) {
    return null;
  }
  return parsed;
}
