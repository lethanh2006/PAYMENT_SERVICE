import type { ConfigService } from '@nestjs/config';

import { appLogger } from '../../common/logging/logger';
import { RabbitMQService, UnprocessableMessage } from './rabbitmq.service';

type Handler = (content: unknown) => Promise<void>;

interface ConsumerInternals {
  processMessage(...args: unknown[]): Promise<void>;
}

function harness(handler: Handler, content = JSON.stringify({ ok: true })) {
  const service = new RabbitMQService({
    get: () => undefined,
  } as unknown as ConfigService);
  const channel = {
    ack: jest.fn(),
    nack: jest.fn(),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    sendToQueue: jest.fn(
      (
        _queue: string,
        _content: Buffer,
        _options: unknown,
        callback: (error?: unknown) => void,
      ) => callback(),
    ),
  };
  const message = {
    content: Buffer.from(content),
    properties: { headers: { 'x-request-id': 'req-1' } },
  };
  return {
    channel,
    message,
    run: () =>
      (service as unknown as ConsumerInternals).processMessage(
        channel,
        'payment.q',
        message,
        handler,
      ),
  };
}

describe('RabbitMQService: nhận message', () => {
  beforeEach(() => jest.spyOn(appLogger, 'error').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('xử lý xong mới ack', async () => {
    const { channel, message, run } = harness(() => Promise.resolve());

    await run();

    expect(channel.ack).toHaveBeenCalledWith(message);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('lỗi tạm thời: chép sang .retry có hạn 5 giây rồi mới ack bản gốc', async () => {
    const { channel, message, run } = harness(() =>
      Promise.reject(new Error('database chập chờn')),
    );

    await run();

    expect(channel.assertQueue).toHaveBeenCalledWith(
      'payment.q.retry',
      expect.objectContaining({
        arguments: expect.objectContaining({
          'x-message-ttl': 5000,
          'x-dead-letter-routing-key': 'payment.q',
        }) as unknown,
      }),
    );
    expect(channel.sendToQueue.mock.calls[0][0]).toBe('payment.q.retry');
    expect(channel.ack).toHaveBeenCalledWith(message);
  });

  it.each([
    ['message không xử lý được', new UnprocessableMessage('sai cấu trúc')],
  ])('%s: vào .dead, không thử lại', async (_case, error) => {
    const { channel, run } = harness(() => Promise.reject(error));

    await run();

    expect(channel.sendToQueue.mock.calls[0][0]).toBe('payment.q.dead');
  });

  it('nội dung không phải JSON: vào .dead', async () => {
    const { channel, run } = harness(() => Promise.resolve(), '{hỏng');

    await run();

    expect(channel.sendToQueue.mock.calls[0][0]).toBe('payment.q.dead');
  });

  it('không lưu được bản retry thì trả message về queue, không ack', async () => {
    const { channel, message, run } = harness(() =>
      Promise.reject(new Error('lỗi tạm')),
    );
    channel.sendToQueue.mockImplementation(
      (
        _queue: string,
        _content: Buffer,
        _options: unknown,
        callback: (error?: unknown) => void,
      ) => callback(new Error('broker từ chối')),
    );

    await run();

    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(message, false, true);
  });
});
