import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { injectTraceHeaders } from '@nrapp/observability';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../common/auth';
import { userIdOf } from '../../common/auth';
import {
  PaymentEntity,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
} from '../database/entities/payment.entity';
import type { CreatePaymentQrDto } from './dto/create-payment-qr.dto';
import {
  CassoSignatureService,
  sortCassoPayload,
} from './casso-signature.service';
import {
  PaymentRepository,
  type CassoProcessingResult,
} from './payment.repository';
import { VietQrService } from './vietqr.service';

interface CassoTransaction {
  id: string | number;
  reference?: unknown;
  description: string;
  amount: number;
  accountNumber: string;
  transactionDateTime?: unknown;
  bankAbbreviation?: unknown;
  bankName?: unknown;
}

interface CassoWebhookPayload {
  error: number | string;
  data: CassoTransaction | CassoTransaction[];
}

export interface PaymentResponse {
  paymentId: string;
  orderId: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  paymentMethod: PaymentMethod;
  qrUrl: string;
  transferContent: string;
  expiresAt: string;
  paidAt: string | null;
  createdAt: string;
}

@Injectable()
export class PaymentService {
  private readonly intentTtlMs: number;
  private readonly paymentCodePrefix: string;
  private readonly cassoTimezoneOffset: string;

  constructor(
    private readonly repository: PaymentRepository,
    private readonly vietQrService: VietQrService,
    private readonly cassoSignatureService: CassoSignatureService,
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
    if (!/^[A-Z0-9]{2,8}$/.test(prefix)) {
      throw new Error(
        'PAYMENT_CODE_PREFIX chỉ được gồm 2-8 ký tự A-Z hoặc 0-9',
      );
    }
    this.paymentCodePrefix = prefix;

    const timezone =
      configService.get<string>('CASSO_TIMEZONE_OFFSET')?.trim() ?? '+07:00';
    if (!/^[+-]\d{2}:\d{2}$/.test(timezone)) {
      throw new Error('CASSO_TIMEZONE_OFFSET phải có dạng +07:00');
    }
    this.cassoTimezoneOffset = timezone;
  }

  async createQr(
    dto: CreatePaymentQrDto,
    user: AuthenticatedUser | undefined,
  ): Promise<PaymentResponse> {
    this.assertCanCreateForOrder(dto.orderUserId, user);
    const paymentCode = `${this.paymentCodePrefix}${randomBytes(8)
      .toString('hex')
      .toUpperCase()}`;
    const qrUrl = this.vietQrService.buildQrUrl({
      amount: dto.amount,
      reference: paymentCode,
    });

    const candidate = new PaymentEntity();
    Object.assign(candidate, {
      id: randomUUID(),
      orderId: dto.orderId,
      userId: dto.orderUserId,
      paymentCode,
      amount: dto.amount,
      currency: 'VND',
      status: PaymentStatus.PENDING,
      paymentMethod: PaymentMethod.VIETQR,
      provider: PaymentProvider.CASSO,
      transferDescription:
        this.vietQrService.buildTransferDescription(paymentCode),
      qrUrl,
      destinationAccount: this.vietQrService.getDestinationAccount(),
      providerTransactionId: null,
      providerReference: null,
      providerMetadata: null,
      reviewReason: null,
      expiresAt: new Date(Date.now() + this.intentTtlMs),
      paidAt: null,
    });

    const payment = await this.repository.createOrReuse(candidate);
    this.assertCanRead(payment, user);
    return this.toResponse(payment);
  }

  async getPayment(
    paymentId: string,
    user: AuthenticatedUser | undefined,
  ): Promise<PaymentResponse> {
    const payment = await this.repository.findById(paymentId);
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
    const payment = await this.repository.findLatestByOrder(orderId);
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
    const payments = await this.repository.findHistory(userId, limit);
    return payments.map((payment) => this.toResponse(payment));
  }

  async handleCassoWebhook(
    payload: unknown,
    signatureHeader: string | undefined,
    requestId: string | undefined,
  ): Promise<CassoProcessingResult[]> {
    if (!this.cassoSignatureService.verify(signatureHeader, payload)) {
      throw new ForbiddenException('Chữ ký Casso không hợp lệ');
    }

    const webhook = this.parseWebhook(payload);
    if (Number(webhook.error) !== 0) {
      throw new BadRequestException('Casso báo webhook có lỗi');
    }

    const transactions = Array.isArray(webhook.data)
      ? webhook.data
      : [webhook.data];
    if (transactions.length === 0 || transactions.length > 100) {
      throw new BadRequestException('Số lượng giao dịch webhook không hợp lệ');
    }

    const signatureTimestamp = this.signatureTimestamp(signatureHeader);
    const traceHeaders = injectTraceHeaders();

    const results: CassoProcessingResult[] = [];
    for (const transaction of transactions) {
      const parsed = this.parseTransaction(transaction);
      results.push(
        await this.repository.processCassoTransaction({
          providerEventId: parsed.providerEventId,
          paymentCode: this.extractPaymentCode(parsed.description) ?? '',
          amount: parsed.amount,
          destinationAccount: parsed.accountNumber,
          providerReference: parsed.providerReference,
          payloadHash: this.hashTransaction(transaction),
          signatureTimestamp,
          metadata: parsed.metadata,
          paidAt: parsed.paidAt,
          providerValidationError: parsed.providerValidationError,
          requestId: requestId ?? null,
          traceparent: headerText(traceHeaders.traceparent),
          tracestate: headerText(traceHeaders.tracestate),
        }),
      );
    }
    return results;
  }

  private parseWebhook(value: unknown): CassoWebhookPayload {
    if (!value || typeof value !== 'object') {
      throw new BadRequestException('Payload Casso không hợp lệ');
    }
    const record = value as Record<string, unknown>;
    if (record.error === undefined || record.data === undefined) {
      throw new BadRequestException('Payload Casso thiếu error hoặc data');
    }
    return value as CassoWebhookPayload;
  }

  private parseTransaction(value: unknown): {
    providerEventId: string;
    description: string;
    amount: number;
    accountNumber: string;
    providerReference: string | null;
    paidAt: Date | null;
    providerValidationError: string | null;
    metadata: Record<string, unknown>;
  } {
    if (!value || typeof value !== 'object') {
      throw new BadRequestException('Dữ liệu giao dịch Casso không hợp lệ');
    }
    const transaction = value as CassoTransaction;
    const providerEventId = String(transaction.id ?? '').trim();
    if (!providerEventId || providerEventId.length > 128) {
      throw new BadRequestException('Mã giao dịch Casso không hợp lệ');
    }
    if (typeof transaction.description !== 'string') {
      throw new BadRequestException(
        'Giao dịch Casso thiếu nội dung chuyển khoản',
      );
    }
    if (!Number.isSafeInteger(transaction.amount) || transaction.amount === 0) {
      throw new BadRequestException('Số tiền giao dịch Casso không hợp lệ');
    }

    const accountNumber =
      typeof transaction.accountNumber === 'string'
        ? transaction.accountNumber
        : '';
    const providerReference =
      typeof transaction.reference === 'string'
        ? transaction.reference.slice(0, 160)
        : null;
    const transactionDateTime =
      typeof transaction.transactionDateTime === 'string'
        ? transaction.transactionDateTime.trim()
        : null;
    const paidAt = this.parseTransactionDate(transactionDateTime);

    return {
      providerEventId,
      description: transaction.description,
      amount: transaction.amount,
      accountNumber,
      providerReference,
      paidAt,
      providerValidationError: paidAt
        ? null
        : 'Thời gian giao dịch Casso không hợp lệ',
      metadata: {
        ...(transactionDateTime
          ? { transactionDateTime: transactionDateTime.slice(0, 64) }
          : {}),
        ...(typeof transaction.bankAbbreviation === 'string'
          ? { bankAbbreviation: transaction.bankAbbreviation.slice(0, 20) }
          : {}),
        ...(typeof transaction.bankName === 'string'
          ? { bankName: transaction.bankName.slice(0, 80) }
          : {}),
      },
    };
  }

  private extractPaymentCode(description: string): string | null {
    let decoded = description;
    try {
      decoded = decodeURIComponent(description.replace(/\+/g, '%20'));
    } catch {
      decoded = description.replace(/%20/gi, ' ');
    }
    const normalized = decoded.normalize('NFKC').toUpperCase();
    const expectedLength = this.paymentCodePrefix.length + 16;
    return (
      normalized
        .split(/[^A-Z0-9]+/)
        .find(
          (part) =>
            part.length === expectedLength &&
            part.startsWith(this.paymentCodePrefix) &&
            /^[A-Z0-9]+$/.test(part),
        ) ?? null
    );
  }

  private signatureTimestamp(header: string | undefined): string | null {
    return header?.match(/(?:^|,)\s*t=(\d+)/)?.[1] ?? null;
  }

  private hashTransaction(transaction: unknown): string {
    let canonicalTransaction: string | undefined;
    try {
      canonicalTransaction = JSON.stringify(sortCassoPayload(transaction));
    } catch {
      throw new BadRequestException('Không thể chuẩn hóa giao dịch Casso');
    }
    if (canonicalTransaction === undefined) {
      throw new BadRequestException('Không thể chuẩn hóa giao dịch Casso');
    }
    return createHash('sha256')
      .update(canonicalTransaction, 'utf8')
      .digest('hex');
  }

  private parseTransactionDate(value: string | null): Date | null {
    if (!value) {
      return null;
    }

    const match = value.match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?$/,
    );
    if (!match) {
      return null;
    }
    const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
      match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));
    if (
      calendarDate.getUTCFullYear() !== year ||
      calendarDate.getUTCMonth() !== month - 1 ||
      calendarDate.getUTCDate() !== day ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    ) {
      return null;
    }

    const isoLike = value.replace(' ', 'T');
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(isoLike);
    const parsed = new Date(
      hasTimezone ? isoLike : `${isoLike}${this.cassoTimezoneOffset}`,
    );
    return Number.isNaN(parsed.getTime()) ? null : parsed;
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
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      paymentMethod: payment.paymentMethod,
      qrUrl: payment.qrUrl,
      transferContent: payment.transferDescription,
      expiresAt: payment.expiresAt.toISOString(),
      paidAt: payment.paidAt?.toISOString() ?? null,
      createdAt: payment.createdAt.toISOString(),
    };
  }
}

function headerText(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 512 ? value : null;
}
