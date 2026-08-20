import type { ConfigService } from '@nestjs/config';
import type { PaymentRepository } from './payment.repository';
import { PaymentExpiryWorker } from './payment-expiry.worker';

describe('PaymentExpiryWorker', () => {
  it('đánh dấu các intent PENDING quá hạn', async () => {
    const expirePendingPayments = jest.fn(() => Promise.resolve(3));
    const repository = {
      expirePendingPayments,
    } as unknown as PaymentRepository;
    const config = {
      get: jest.fn(() => '60000'),
    } as unknown as ConfigService;
    const worker = new PaymentExpiryWorker(repository, config);

    await expect(worker.sweep()).resolves.toBe(3);
    expect(expirePendingPayments).toHaveBeenCalledTimes(1);
  });

  it('không làm worker chết khi PostgreSQL tạm lỗi', async () => {
    const repository = {
      expirePendingPayments: jest.fn(() =>
        Promise.reject(new Error('database unavailable')),
      ),
    } as unknown as PaymentRepository;
    const config = {
      get: jest.fn(() => '60000'),
    } as unknown as ConfigService;
    const worker = new PaymentExpiryWorker(repository, config);

    await expect(worker.sweep()).resolves.toBe(0);
  });
});
