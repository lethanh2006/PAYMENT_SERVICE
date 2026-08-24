import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { injectTraceHeaders } from '@nrapp/observability';
import * as amqp from 'amqplib';

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);
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
    const headers = injectTraceHeaders(
      options.requestId ? { 'x-request-id': options.requestId } : {},
    );
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
    this.logger.log('Payment Service đã kết nối RabbitMQ');
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
