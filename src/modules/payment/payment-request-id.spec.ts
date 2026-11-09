import { ConfigService } from '@nestjs/config';

import { PaymentService } from './payment.service';

describe('Payment outbox request ID', () => {
  it('lưu request ID cùng outbox trong transaction webhook', async () => {
    const repository = {
      processPayosTransaction: jest.fn().mockResolvedValue({
        outcome: 'PROCESSED',
        paymentId: '4ca949f2-005b-4a1a-9168-6519f0a19777',
      }),
    };
    const payosClient = {
      verifyWebhook: jest.fn((payload: { data: unknown }) => payload.data),
    };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const service = new PaymentService(
      repository as never,
      payosClient as never,
      config as unknown as ConfigService,
    );

    await service.handlePayosWebhook(
      {
        code: '00',
        data: {
          code: '00',
          orderCode: 1_787_540_400_12345,
          amount: 125_000,
          reference: 'FT26082400001',
          paymentLinkId: 'link-1',
          transactionDateTime: '2026-08-24 10:00:00',
        },
        signature: 'checked-by-client',
      },
      'req-payment',
    );

    expect(repository.processPayosTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-payment' }),
    );
  });
});
