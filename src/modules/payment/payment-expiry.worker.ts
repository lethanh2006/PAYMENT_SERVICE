import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentRepository } from './payment.repository';

@Injectable()
export class PaymentExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentExpiryWorker.name);
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
      const expired = await this.repository.expirePendingPayments();
      if (expired > 0) {
        this.logger.log(`Đã đánh dấu hết hạn ${expired} payment PENDING`);
      }
      return expired;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Không thể hết hạn payment: ${message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
