import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type QueryResult } from 'typeorm';
import { RabbitMQService } from '../rabbitmq/rabbitmq.service';

interface ClaimedOutboxEvent {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  request_id: string | null;
  attempt_count: number;
}

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly rabbitMQService: RabbitMQService,
    configService: ConfigService,
  ) {
    const configured = Number(
      configService.get<string>('PAYMENT_OUTBOX_INTERVAL_MS') ?? 1_000,
    );
    this.intervalMs =
      Number.isSafeInteger(configured) && configured >= 250
        ? configured
        : 1_000;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    this.timer.unref();
    void this.flush();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async flush(): Promise<void> {
    if (this.running || !this.rabbitMQService.isReady()) {
      return;
    }
    this.running = true;
    try {
      const events = await this.claimBatch();
      for (const event of events) {
        await this.publishOne(event);
      }
    } catch (error: unknown) {
      this.logger.error(`Không phát được outbox: ${toMessage(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async claimBatch(): Promise<ClaimedOutboxEvent[]> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      const rawResult: unknown = await queryRunner.query(
        `
          WITH candidates AS (
            SELECT id
            FROM outbox_events
            WHERE published_at IS NULL
              AND next_attempt_at <= now()
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 20
          )
          UPDATE outbox_events AS event
          SET attempt_count = event.attempt_count + 1,
              next_attempt_at = now() + interval '30 seconds'
          FROM candidates
          WHERE event.id = candidates.id
          RETURNING event.id, event.aggregate_id, event.event_type,
                    event.payload, event.request_id, event.attempt_count
        `,
        [],
        true,
      );
      const result = rawResult as QueryResult<ClaimedOutboxEvent>;
      return result.records;
    } finally {
      await queryRunner.release();
    }
  }

  private async publishOne(event: ClaimedOutboxEvent): Promise<void> {
    try {
      await this.rabbitMQService.publish(
        'canteen.payment.succeeded.v1',
        event.payload,
        {
          messageId: event.id,
          correlationId: event.aggregate_id,
          requestId: event.request_id,
        },
      );
      await this.dataSource.query(
        `UPDATE outbox_events
         SET published_at = now(), last_error = NULL
         WHERE id = $1 AND published_at IS NULL`,
        [event.id],
      );
    } catch (error: unknown) {
      const delaySeconds = Math.min(300, 2 ** Math.min(event.attempt_count, 8));
      await this.dataSource.query(
        `UPDATE outbox_events
         SET last_error = $2,
             next_attempt_at = now() + ($3 * interval '1 second')
         WHERE id = $1 AND published_at IS NULL`,
        [event.id, toMessage(error).slice(0, 500), delaySeconds],
      );
      throw error;
    }
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
