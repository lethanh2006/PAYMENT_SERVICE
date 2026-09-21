import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { appLogger } from '../../common/logging/logger';
import type { RabbitMQService } from '../rabbitmq/rabbitmq.service';
import { OutboxPublisher } from './outbox.publisher';

describe('OutboxPublisher logging', () => {
  afterEach(() => jest.restoreAllMocks());

  it('giữ request ID và chỉ ghi detailed error khi hết retry', async () => {
    const event = {
      id: '5ad62f76-3ca1-46cb-ab36-9696b40e50d1',
      aggregate_id: '4ca949f2-005b-4a1a-9168-6519f0a19777',
      event_type: 'payment.succeeded.v1',
      payload: { eventType: 'payment.succeeded.v1' },
      request_id: 'req-outbox',
      attempt_count: 1,
    };
    const claimQuery = jest.fn((sql: string) => {
      void sql;
      return Promise.resolve({ records: [event] });
    });
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: claimQuery,
      release: jest.fn().mockResolvedValue(undefined),
    };
    const updateQuery = jest.fn().mockResolvedValue(undefined);
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
      query: updateQuery,
    } as unknown as DataSource;
    const publish = jest
      .fn()
      .mockRejectedValue(new Error('broker unavailable'));
    const rabbitMQ = {
      isReady: jest.fn().mockReturnValue(true),
      publish,
    } as unknown as RabbitMQService;
    const config = {
      get: jest.fn((name: string) =>
        name === 'PAYMENT_OUTBOX_MAX_ATTEMPTS' ? '1' : undefined,
      ),
    } as unknown as ConfigService;
    const errorSpy = jest.spyOn(appLogger, 'error').mockImplementation();
    const publisher = new OutboxPublisher(dataSource, rabbitMQ, config);

    await publisher.flush();

    const claimSql = claimQuery.mock.calls[0][0];
    expect(claimSql).toContain('failed_at IS NULL');
    expect(claimSql).toContain('event.request_id');
    expect(publish).toHaveBeenCalledWith(
      'canteen.payment.succeeded.v1',
      event.payload,
      {
        messageId: event.id,
        correlationId: event.aggregate_id,
        requestId: event.request_id,
      },
    );
    expect(updateQuery).toHaveBeenCalledWith(
      expect.stringContaining('failed_at = CASE WHEN $4'),
      expect.arrayContaining([event.id, 'broker unavailable', true]),
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatchObject({
      'event.name': 'payment.outbox.publish.exhausted',
      'error.code': 'OUTBOX_PUBLISH_EXHAUSTED',
    });
  });

  it('mặc định retry vô hạn và không đánh dấu failed_at', async () => {
    const event = {
      id: '5ad62f76-3ca1-46cb-ab36-9696b40e50d1',
      aggregate_id: '4ca949f2-005b-4a1a-9168-6519f0a19777',
      event_type: 'payment.succeeded.v1',
      payload: { eventType: 'payment.succeeded.v1' },
      request_id: null,
      attempt_count: 99,
    };
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue({ records: [event] }),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const updateQuery = jest.fn().mockResolvedValue(undefined);
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
      query: updateQuery,
    } as unknown as DataSource;
    const rabbitMQ = {
      isReady: jest.fn().mockReturnValue(true),
      publish: jest.fn().mockRejectedValue(new Error('broker unavailable')),
    } as unknown as RabbitMQService;
    const config = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const warnSpy = jest.spyOn(appLogger, 'warn').mockImplementation();
    const publisher = new OutboxPublisher(dataSource, rabbitMQ, config);

    await publisher.flush();

    expect(updateQuery).toHaveBeenCalledWith(
      expect.stringContaining('failed_at = CASE WHEN $4'),
      expect.arrayContaining([event.id, 'broker unavailable', false]),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
