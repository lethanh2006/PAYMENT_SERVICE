import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { logException } from '@nrapp/observability';
import { appLogger } from '../../common/logging/logger';
import { PaymentRepository } from './payment.repository';

@Injectable()
export class PaymentExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly repository: PaymentRepository,
    configService: ConfigService,
  ) {
    const configured = Number(
      configService.get<string>('PAYMENT_EXPIRY_INTERVAL_MS') ?? 60_000,
    );
    this.intervalMs =
      Number.isSafeInteger(configured) && configured >= 5_000
        ? configured
        : 60_000;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref();
    void this.sweep();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sweep(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      try {
        const expired = await this.repository.expirePendingPayments();
        if (expired > 0) {
          appLogger.info(
            {
              'event.name': 'payment.expiry.completed',
              'payment.expired.count': expired,
            },
            'Đã đánh dấu payment PENDING hết hạn',
          );
        }
        return expired;
      } catch (error: unknown) {
        logException(
          appLogger,
          'payment.expiry.failed',
          error,
          { 'job.name': 'payment-expiry' },
          {
            message: 'Không thể hết hạn payment',
            classification: {
              statusCode: 500,
              code: 'PAYMENT_EXPIRY_FAILED',
              expected: false,
              retryable: true,
            },
          },
        );
        return 0;
      }
    } finally {
      this.running = false;
    }
  }
}
