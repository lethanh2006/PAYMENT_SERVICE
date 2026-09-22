import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import { EventEmitter } from 'node:events';
import { RabbitMQService } from './rabbitmq.service';

jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));

function createService() {
  const configService = {
    get: jest.fn().mockReturnValue(undefined),
  } as unknown as ConfigService;
  return new RabbitMQService(configService);
}

function createTransport() {
  const channel = Object.assign(new EventEmitter(), {
    close: jest.fn().mockResolvedValue(undefined),
  });
  const connection = Object.assign(new EventEmitter(), {
    close: jest.fn().mockResolvedValue(undefined),
    createConfirmChannel: jest.fn().mockResolvedValue(channel),
  });
  jest.mocked(amqp.connect).mockResolvedValue(connection as never);
  return { channel, connection };
}

describe('RabbitMQ payment channel lifecycle v2', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it.each(['error', 'close'] as const)(
    'xóa readiness và đóng connection khi channel phát %s',
    async (eventName) => {
      const { channel, connection } = createTransport();
      const service = createService();
      await service.onModuleInit();
      expect(service.isReady()).toBe(true);

      if (eventName === 'error') {
        channel.emit('error', new Error('channel failed'));
      } else {
        channel.emit('close');
      }

      expect(service.isReady()).toBe(false);
      expect(connection.close).toHaveBeenCalledTimes(1);
      await service.onModuleDestroy();
    },
  );
});
