import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    channel.sendToQueue(queueName, Buffer.from(JSON.stringify(payload)), {
      persistent: true,
      contentType: 'application/json',
      messageId: options.messageId,
      correlationId: options.correlationId,
      ...(options.requestId
        ? { headers: { 'x-request-id': options.requestId } }
        : {}),
    });
    await channel.waitForConfirms();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch (error: unknown) {
      this.logger.warn(`Không đóng được RabbitMQ: ${toMessage(error)}`);
    } finally {
      this.channel = null;
      this.connection = null;
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
      this.logger.warn(`Kết nối RabbitMQ lỗi: ${toMessage(error)}`);
    });
    connection.on('close', () => {
      this.connection = null;
      this.channel = null;
      if (!this.shuttingDown) {
        this.logger.warn('Kết nối RabbitMQ đã đóng, sẽ kết nối lại');
        this.scheduleReconnect();
      }
    });
    this.connection = connection;
    this.channel = channel;
    this.logger.log('Payment Service đã kết nối RabbitMQ');
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
