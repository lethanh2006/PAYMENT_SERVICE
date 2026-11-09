import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { logException } from '@nrapp/observability';

import { appLogger } from '../../common/logging/logger';
import {
  type PaymentEntity,
  PaymentStatus,
} from '../../database/entities/payment.entity';
import { PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';
import { PayosClient } from './payos.client';

// Cho webhook 2 phút để tới trước; đối soát chỉ là lưới an toàn khi webhook lỡ.
const WEBHOOK_GRACE_MS = 2 * 60_000;
// Link sống 15 phút; hỏi tiếp tới 24 giờ vì tiền chuyển sát giờ hết hạn vẫn có thể về muộn.
const RECONCILE_WINDOW_MS = 24 * 60 * 60_000;
const BATCH_SIZE = 20;

/**
 * Đối soát chủ động: hỏi PayOS trạng thái các link chưa chốt rồi ghi nhận tiền về mà webhook không
 * báo (server tắt lúc PayOS gọi, mạng lỗi), và chốt link khách đã huỷ hoặc PayOS đã cho hết hạn.
 */
@Injectable()
export class PaymentReconciliationWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly payments: PaymentRepository,
    private readonly paymentService: PaymentService,
    private readonly payosClient: PayosClient,
    configService: ConfigService,
  ) {
    const configured = Number(
      configService.get<string>('PAYMENT_RECONCILE_INTERVAL_MS') ?? 60_000,
    );
    this.intervalMs =
      Number.isSafeInteger(configured) && configured >= 10_000
        ? configured
        : 60_000;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Số payment đã đối soát xong trong lượt này. */
  async sweep(now = new Date()): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const due = await this.payments.findDueForReconciliation({
        createdBefore: new Date(now.getTime() - WEBHOOK_GRACE_MS),
        createdAfter: new Date(now.getTime() - RECONCILE_WINDOW_MS),
        checkedBefore: new Date(now.getTime() - this.intervalMs),
        limit: BATCH_SIZE,
      });
      let reconciled = 0;
      for (const payment of due) {
        // Một link lỗi (PayOS từ chối, mạng chập) không chặn các link còn lại; lượt sau hỏi lại.
        try {
          await this.reconcile(payment);
          reconciled += 1;
        } catch (error: unknown) {
          logException(
            appLogger,
            'payment.reconcile.failed',
            error,
            {
              'payment.id': payment.id,
              'payment.link_id': payment.paymentLinkId,
            },
            {
              message: 'Không đối soát được link PayOS',
              classification: {
                statusCode: 502,
                code: 'PAYMENT_RECONCILE_FAILED',
                expected: true,
                retryable: true,
                logLevel: 'warn',
              },
            },
          );
        }
      }
      return reconciled;
    } catch (error: unknown) {
      logException(
        appLogger,
        'payment.reconcile.failed',
        error,
        { 'job.name': 'payment-reconciliation' },
        {
          message: 'Không đọc được danh sách payment cần đối soát',
          classification: {
            statusCode: 500,
            code: 'PAYMENT_RECONCILE_FAILED',
            expected: false,
            retryable: true,
          },
        },
      );
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async reconcile(payment: PaymentEntity): Promise<void> {
    const link = await this.payosClient.getPaymentLink(
      payment.paymentLinkId as string,
    );

    let recovered = 0;
    for (const transaction of link.transactions) {
      const result = await this.paymentService.recordPayosTransaction(
        {
          orderCode: Number(payment.paymentCode),
          paymentLinkId: payment.paymentLinkId,
          ...transaction,
        },
        null,
        null,
      );
      if (result.outcome === 'PROCESSED') {
        recovered += 1;
      }
    }

    const finalStatus =
      link.status === 'CANCELLED'
        ? PaymentStatus.CANCELLED
        : link.status === 'EXPIRED'
          ? PaymentStatus.EXPIRED
          : null;
    await this.payments.recordProviderStatus(
      payment.id,
      link.status,
      finalStatus,
    );

    const context = {
      'payment.id': payment.id,
      'order.id': payment.orderId,
      'payment.provider_status': link.status,
    };
    if (recovered > 0) {
      appLogger.warn(
        { 'event.name': 'payment.reconcile.recovered', ...context },
        'Đối soát ghi nhận tiền về mà webhook PayOS chưa báo',
      );
    } else if (link.status === 'PAID' && link.transactions.length === 0) {
      appLogger.error(
        {
          'event.name': 'payment.reconcile.mismatch',
          'error.code': 'PAYMENT_NEEDS_RECONCILIATION',
          ...context,
        },
        'PayOS báo link đã trả nhưng không có giao dịch nào, cần kiểm tra tay',
      );
    } else if (finalStatus === PaymentStatus.CANCELLED) {
      appLogger.info(
        { 'event.name': 'payment.reconcile.cancelled', ...context },
        'Link PayOS đã bị huỷ, lần tạo QR sau sẽ cấp link mới',
      );
    }
  }
}
