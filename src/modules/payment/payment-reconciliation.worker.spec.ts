import { ConfigService } from '@nestjs/config';

import {
  PaymentEntity,
  PaymentStatus,
} from '../../database/entities/payment.entity';
import { PaymentReconciliationWorker } from './payment-reconciliation.worker';

function payment(overrides: Partial<PaymentEntity> = {}): PaymentEntity {
  return Object.assign(new PaymentEntity(), {
    id: 'p1',
    orderId: '507f1f77bcf86cd799439011',
    paymentCode: '176200000012345',
    paymentLinkId: 'link-1',
    status: PaymentStatus.EXPIRED,
    ...overrides,
  });
}

const paidTransaction = {
  reference: 'FT1',
  amount: 45_000,
  transactionDateTime: '2026-11-04 10:15:00',
  counterAccountBankName: null,
  counterAccountName: null,
};

function setup(due: PaymentEntity[]) {
  const payments = {
    findDueForReconciliation: jest.fn().mockResolvedValue(due),
    recordProviderStatus: jest.fn().mockResolvedValue(undefined),
  };
  const paymentService = {
    recordPayosTransaction: jest
      .fn()
      .mockResolvedValue({ outcome: 'PROCESSED', paymentId: 'p1' }),
  };
  const payosClient = { getPaymentLink: jest.fn() };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const worker = new PaymentReconciliationWorker(
    payments as never,
    paymentService as never,
    payosClient as never,
    config as unknown as ConfigService,
  );
  return { worker, payments, paymentService, payosClient };
}

describe('PaymentReconciliationWorker', () => {
  it('ghi nhận tiền về mà webhook lỡ, qua đúng đường xử lý của webhook', async () => {
    const { worker, payments, paymentService, payosClient } = setup([
      payment(),
    ]);
    payosClient.getPaymentLink.mockResolvedValue({
      status: 'PAID',
      transactions: [paidTransaction],
    });

    await expect(worker.sweep()).resolves.toBe(1);

    expect(payosClient.getPaymentLink).toHaveBeenCalledWith('link-1');
    expect(paymentService.recordPayosTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        orderCode: 176200000012345,
        paymentLinkId: 'link-1',
        reference: 'FT1',
        amount: 45_000,
      }),
      null,
      null,
    );
    expect(payments.recordProviderStatus).toHaveBeenCalledWith(
      'p1',
      'PAID',
      null,
    );
  });

  it.each([
    ['CANCELLED', PaymentStatus.CANCELLED],
    ['EXPIRED', PaymentStatus.EXPIRED],
    ['PENDING', null],
  ])(
    'link PayOS %s không có tiền về thì chỉ ghi trạng thái',
    async (providerStatus, finalStatus) => {
      const { worker, payments, paymentService, payosClient } = setup([
        payment({ status: PaymentStatus.PENDING }),
      ]);
      payosClient.getPaymentLink.mockResolvedValue({
        status: providerStatus,
        transactions: [],
      });

      await worker.sweep();

      expect(paymentService.recordPayosTransaction).not.toHaveBeenCalled();
      expect(payments.recordProviderStatus).toHaveBeenCalledWith(
        'p1',
        providerStatus,
        finalStatus,
      );
    },
  );

  it('một link lỗi không chặn các link còn lại', async () => {
    const { worker, payments, payosClient } = setup([
      payment({ id: 'p1' }),
      payment({ id: 'p2', paymentLinkId: 'link-2' }),
    ]);
    payosClient.getPaymentLink
      .mockRejectedValueOnce(new Error('PayOS 503'))
      .mockResolvedValueOnce({ status: 'PENDING', transactions: [] });

    await expect(worker.sweep()).resolves.toBe(1);

    expect(payments.recordProviderStatus).toHaveBeenCalledTimes(1);
    expect(payments.recordProviderStatus).toHaveBeenCalledWith(
      'p2',
      'PENDING',
      null,
    );
  });

  it('chỉ hỏi payment đã qua 2 phút chờ webhook, trong cửa sổ 24 giờ', async () => {
    const { worker, payments } = setup([]);

    await worker.sweep(new Date('2026-11-09T10:00:00.000Z'));

    expect(payments.findDueForReconciliation).toHaveBeenCalledWith({
      createdBefore: new Date('2026-11-09T09:58:00.000Z'),
      createdAfter: new Date('2026-11-08T10:00:00.000Z'),
      checkedBefore: new Date('2026-11-09T09:59:00.000Z'),
      limit: 20,
    });
  });
});
