import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  logAndRecordException,
  recordExceptionOnActiveSpan,
  runWithLogContext,
  sanitizeText,
  withMessageSpan,
} from '@nrapp/observability';
import { DataSource, type QueryResult } from 'typeorm';
import { appLogger } from '../../common/observability';
import { RabbitMQService } from '../rabbitmq/rabbitmq.service';

interface ClaimedOutboxEvent {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  request_id: string | null;
  traceparent: string | null;
  tracestate: string | null;
  attempt_count: number;
}

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
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
    const configuredMaxAttempts = Number(
      configService.get<string>('PAYMENT_OUTBOX_MAX_ATTEMPTS') ?? 0,
    );
    this.maxAttempts =
      Number.isSafeInteger(configuredMaxAttempts) && configuredMaxAttempts >= 0
        ? configuredMaxAttempts
        : 0;
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
      logAndRecordException(
        appLogger,
        'payment.outbox.flush.failed',
        error,
        { 'messaging.system': 'rabbitmq' },
        {
          message: 'Không thể xử lý batch payment outbox',
          classification: {
            statusCode: 500,
            code: 'OUTBOX_FLUSH_FAILED',
            expected: false,
            retryable: true,
          },
        },
      );
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
              AND failed_at IS NULL
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
                    event.payload, event.request_id, event.traceparent,
                    event.tracestate, event.attempt_count
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
    const queueName = 'canteen.payment.succeeded.v1';
    const parentHeaders = {
      ...(event.traceparent ? { traceparent: event.traceparent } : {}),
      ...(event.tracestate ? { tracestate: event.tracestate } : {}),
    };

    await runWithLogContext(
      {
        request_id: event.request_id ?? undefined,
        'messaging.message.id': event.id,
      },
      () =>
        withMessageSpan(
          `${queueName} publish`,
          parentHeaders,
          async () => {
            try {
              await this.rabbitMQService.publish(queueName, event.payload, {
                messageId: event.id,
                correlationId: event.aggregate_id,
                requestId: event.request_id,
              });
              await this.dataSource.query(
                `UPDATE outbox_events
                 SET published_at = now(), last_error = NULL
                 WHERE id = $1 AND published_at IS NULL AND failed_at IS NULL`,
                [event.id],
              );
            } catch (error: unknown) {
              const exhausted =
                this.maxAttempts > 0 && event.attempt_count >= this.maxAttempts;
              if (!exhausted) {
                recordExceptionOnActiveSpan(error, {
                  code: 'OUTBOX_PUBLISH_RETRY',
                });
              }
              await this.recordPublishFailure(event, error);
            }
          },
          {
            kind: 3,
            attributes: {
              'messaging.system': 'rabbitmq',
              'messaging.destination.name': queueName,
              'messaging.operation.type': 'publish',
              'messaging.message.id': event.id,
            },
          },
        ),
    );
  }

  private async recordPublishFailure(
    event: ClaimedOutboxEvent,
    error: unknown,
  ): Promise<void> {
    const exhausted =
      this.maxAttempts > 0 && event.attempt_count >= this.maxAttempts;
    const delaySeconds = Math.min(300, 2 ** Math.min(event.attempt_count, 8));
    await this.dataSource.query(
      `UPDATE outbox_events
       SET last_error = $2,
           next_attempt_at = now() + ($3 * interval '1 second'),
           failed_at = CASE WHEN $4 THEN now() ELSE failed_at END
       WHERE id = $1 AND published_at IS NULL AND failed_at IS NULL`,
      [
        event.id,
        sanitizeText(toMessage(error)).slice(0, 500),
        delaySeconds,
        exhausted,
      ],
    );

    const context = {
      'messaging.system': 'rabbitmq',
      'messaging.destination.name': 'canteen.payment.succeeded.v1',
      'messaging.message.id': event.id,
      'messaging.retry.count': event.attempt_count,
      ...(this.maxAttempts > 0
        ? { 'messaging.retry.max': this.maxAttempts }
        : {}),
    };
    if (exhausted) {
      logAndRecordException(
        appLogger,
        'payment.outbox.publish.exhausted',
        error,
        context,
        {
          message: 'Payment outbox đã hết số lần phát lại',
          classification: {
            statusCode: 500,
            code: 'OUTBOX_PUBLISH_EXHAUSTED',
            expected: false,
            retryable: false,
          },
        },
      );
      return;
    }

    appLogger.warn(
      {
        ...context,
        'event.name': 'payment.outbox.publish.retry_scheduled',
        'error.code': 'OUTBOX_PUBLISH_RETRY',
      },
      'Đã lên lịch phát lại payment outbox',
    );
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
