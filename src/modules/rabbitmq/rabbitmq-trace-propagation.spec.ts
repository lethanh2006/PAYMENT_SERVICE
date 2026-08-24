import { ConfigService } from '@nestjs/config';
import { injectTraceHeaders } from '@nrapp/observability';
import * as amqp from 'amqplib';
import { EventEmitter } from 'node:events';
import { RabbitMQService } from './rabbitmq.service';

jest.mock('amqplib', () => ({ connect: jest.fn() }));
jest.mock('@nrapp/observability', () => ({
  ...jest.requireActual<typeof import('@nrapp/observability')>(
    '@nrapp/observability',
  ),
  injectTraceHeaders: jest.fn(),
}));

describe('RabbitMQ payment trace propagation', () => {
  it('inject traceparent và request id vào AMQP headers', async () => {
    jest.mocked(injectTraceHeaders).mockImplementation((headers) => ({
      ...headers,
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'vendor=value',
    }));
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
      expect.objectContaining({
        headers: {
          'x-request-id': 'req-1',
          traceparent:
            '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
          tracestate: 'vendor=value',
        },
      }),
    );
    await service.onModuleDestroy();
  });
});
