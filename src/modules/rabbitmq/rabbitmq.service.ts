import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createErrorId,
  runWithLogContext,
  SAFE_REQUEST_ID,
} from '@nrapp/observability';
import * as amqp from 'amqplib';

import { appLogger } from '../../common/logging/logger';

/** Message không bao giờ xử lý được: chuyển sang `<queue>.dead` thay vì thử lại. */
export class UnprocessableMessage extends Error {}

type MessageHandler = (content: unknown) => Promise<void>;

/** Payment gửi sự kiện thanh toán qua outbox và nhận sự kiện Canteen báo tiền không áp được vào đơn. */
@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);
  private readonly subscriptions = new Map<string, MessageHandler>();
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.ConfirmChannel | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connecting: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.ensureConnected().catch((error: unknown) => {
      this.logger.warn(`RabbitMQ chưa sẵn sàng: ${toMessage(error)}`);
      this.scheduleReconnect();
    });
  }

  isReady(): boolean {
    return this.connection !== null && this.channel !== null;
  }

  async subscribe(queueName: string, handler: MessageHandler): Promise<void> {
    this.subscriptions.set(queueName, handler);
    if (this.channel) {
      await this.registerSubscription(this.channel, queueName, handler);
    }
  }

  async publish(
    queueName: string,
    payload: Record<string, unknown>,
    options: {
      messageId: string;
      correlationId: string;
      requestId?: string | null;
    },
  ): Promise<void> {
    await this.ensureConnected();
    const channel = this.channel;
    if (!channel) {
      throw new Error('Kênh RabbitMQ chưa sẵn sàng');
    }

    const deadLetterQueue = `${queueName}.dlq`;
    await channel.assertQueue(deadLetterQueue, { durable: true });
    await channel.assertQueue(queueName, { durable: true });
    const headers = options.requestId
      ? { 'x-request-id': options.requestId }
      : {};
    channel.sendToQueue(queueName, Buffer.from(JSON.stringify(payload)), {
      persistent: true,
      contentType: 'application/json',
      messageId: options.messageId,
      correlationId: options.correlationId,
      headers,
    });
    await channel.waitForConfirms();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;
    try {
      await channel?.close();
      await connection?.close();
    } catch (error: unknown) {
      this.logger.warn(`Không đóng được RabbitMQ: ${toMessage(error)}`);
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.isReady()) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const host = this.configService.get<string>('Rabbitmq_Host') || 'localhost';
    const port = Number(
      this.configService.get<string>('Rabbitmq_Port') ||
        this.configService.get<string>('RABBITMQ_AMQP_HOST_PORT') ||
        5672,
    );
    const username =
      this.configService.get<string>('RABBITMQ_USER') ||
      this.configService.get<string>('Rabbitmq_Username') ||
      'guest';
    const password =
      this.configService.get<string>('RABBITMQ_PASSWORD') ||
      this.configService.get<string>('Rabbitmq_Password') ||
      'guest';

    const connection = await amqp.connect({
      protocol: 'amqp',
      hostname: host,
      port,
      username,
      password,
    });
    const channel = await connection.createConfirmChannel();
    connection.on('error', (error) => {
      this.handleTransportUnavailable(
        connection,
        channel,
        `Kết nối RabbitMQ lỗi: ${toMessage(error)}`,
        true,
      );
    });
    connection.on('close', () => {
      this.handleTransportUnavailable(
        connection,
        channel,
        'Kết nối RabbitMQ đã đóng, sẽ kết nối lại',
        false,
      );
    });
    channel.on('error', (error) => {
      this.handleTransportUnavailable(
        connection,
        channel,
        `Kênh RabbitMQ lỗi: ${toMessage(error)}`,
        true,
      );
    });
    channel.on('close', () => {
      this.handleTransportUnavailable(
        connection,
        channel,
        'Kênh RabbitMQ đã đóng, sẽ kết nối lại',
        true,
      );
    });
    this.connection = connection;
    this.channel = channel;
    try {
      for (const [queueName, handler] of this.subscriptions) {
        await this.registerSubscription(channel, queueName, handler);
      }
    } catch (error: unknown) {
      this.connection = null;
      this.channel = null;
      await channel.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
      throw error;
    }
    this.logger.log('Payment Service đã kết nối RabbitMQ');
  }

  private async registerSubscription(
    channel: amqp.ConfirmChannel,
    queueName: string,
    handler: MessageHandler,
  ): Promise<void> {
    // Khai báo đúng tham số như bên gửi (chỉ `durable`), nếu không broker đóng kênh.
    await channel.assertQueue(queueName, { durable: true });
    await channel.prefetch(1);
    await channel.consume(queueName, (message) => {
      if (message) {
        void this.processMessage(channel, queueName, message, handler);
        return;
      }
      this.logger.warn(`Broker huỷ consumer '${queueName}', sẽ kết nối lại`);
      void channel.close().catch(() => undefined);
    });
    this.logger.log(`Đã nhận message từ queue '${queueName}'`);
  }

  private async processMessage(
    channel: amqp.ConfirmChannel,
    queueName: string,
    message: amqp.ConsumeMessage,
    handler: MessageHandler,
  ): Promise<void> {
    const headers: unknown = message.properties.headers;
    const requestIdHeader =
      typeof headers === 'object' && headers !== null
        ? (headers as Record<string, unknown>)['x-request-id']
        : undefined;
    const requestId =
      typeof requestIdHeader === 'string' &&
      SAFE_REQUEST_ID.test(requestIdHeader)
        ? requestIdHeader
        : undefined;

    await runWithLogContext(
      requestId ? { request_id: requestId } : {},
      async () => {
        try {
          await handler(JSON.parse(message.content.toString()) as unknown);
          channel.ack(message);
        } catch (error: unknown) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          appLogger.error(
            {
              'event.name': 'rabbitmq.message.failed',
              'error.id': createErrorId(),
              'error.code': 'MESSAGE_PROCESSING_FAILED',
              'messaging.system': 'rabbitmq',
              'messaging.destination.name': queueName,
              'messaging.operation.type': 'process',
              'exception.type': failure.name,
              'exception.message': failure.message,
            },
            'Không xử lý được message RabbitMQ',
          );
          const retryable =
            !(error instanceof UnprocessableMessage) &&
            !(error instanceof SyntaxError);
          await this.retryOrPark(channel, queueName, message, retryable);
        }
      },
    );
  }

  /** Lỗi tạm: vào `<queue>.retry`, hết 5 giây tự quay lại queue chính. Message hỏng: vào `<queue>.dead`. */
  private async retryOrPark(
    channel: amqp.ConfirmChannel,
    queueName: string,
    message: amqp.ConsumeMessage,
    retryable: boolean,
  ): Promise<void> {
    const destination = `${queueName}.${retryable ? 'retry' : 'dead'}`;
    try {
      await channel.assertQueue(destination, {
        durable: true,
        ...(retryable
          ? {
              arguments: {
                'x-queue-type': 'quorum',
                'x-dead-letter-strategy': 'at-least-once',
                'x-overflow': 'reject-publish',
                'x-message-ttl': 5000,
                'x-dead-letter-exchange': '',
                'x-dead-letter-routing-key': queueName,
              },
            }
          : {}),
      });
      await new Promise<void>((resolve, reject) => {
        channel.sendToQueue(
          destination,
          message.content,
          {
            persistent: true,
            messageId: randomUUID(),
            contentType: 'application/json',
            headers: message.properties.headers as Record<string, unknown>,
          },
          (error: unknown) =>
            error ? reject(new Error(toMessage(error))) : resolve(),
        );
      });
      channel.ack(message);
    } catch (error: unknown) {
      // Chưa lưu được bản retry/dead thì không ack bản gốc: thà xử lý lại còn hơn mất hồ sơ hoàn tiền.
      this.logger.warn(
        `Không chuyển được message sang ${destination}: ${toMessage(error)}`,
      );
      channel.nack(message, false, true);
    }
  }

  private handleTransportUnavailable(
    connection: amqp.ChannelModel,
    channel: amqp.ConfirmChannel,
    message: string,
    closeConnection: boolean,
  ): void {
    const ownsConnection = this.connection === connection;
    const ownsChannel = this.channel === channel;
    if (!ownsConnection && !ownsChannel) {
      return;
    }
    if (ownsConnection) {
      this.connection = null;
    }
    if (ownsChannel) {
      this.channel = null;
    }
    if (this.shuttingDown) {
      return;
    }

    this.logger.warn(message);
    if (closeConnection) {
      void connection.close().catch((error: unknown) => {
        this.logger.warn(
          `Không đóng được kết nối RabbitMQ lỗi: ${toMessage(error)}`,
        );
      });
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected().catch((error: unknown) => {
        this.logger.warn(`Kết nối lại RabbitMQ thất bại: ${toMessage(error)}`);
        this.scheduleReconnect();
      });
    }, 5_000);
    this.reconnectTimer.unref();
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
