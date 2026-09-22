import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import { EventEmitter } from 'node:events';
import { RabbitMQService } from './rabbitmq.service';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

describe('RabbitMQ payment request ID', () => {
  it('truyền request ID trong AMQP headers', async () => {
    const channel = Object.assign(new EventEmitter(), {
      assertQueue: jest.fn().mockResolvedValue(undefined),
      sendToQueue: jest.fn().mockReturnValue(true),
      waitForConfirms: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const connection = Object.assign(new EventEmitter(), {
      createConfirmChannel: jest.fn().mockResolvedValue(channel),
      close: jest.fn().mockResolvedValue(undefined),
    });
    jest.mocked(amqp.connect).mockResolvedValue(connection as never);
    const config = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const service = new RabbitMQService(config);
    await service.onModuleInit();

    await service.publish(
      'canteen.payment.succeeded.v1',
      { eventType: 'payment.succeeded.v1' },
      {
        messageId: 'event-1',
        correlationId: 'payment-1',
        requestId: 'req-1',
      },
    );

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      'canteen.payment.succeeded.v1',
      expect.any(Buffer),
      expect.objectContaining({ headers: { 'x-request-id': 'req-1' } }),
    );
    await service.onModuleDestroy();
  });
});
