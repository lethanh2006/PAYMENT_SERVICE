import { ConfigService } from '@nestjs/config';
import { PaymentService } from './payment.service';

describe('Payment outbox request ID', () => {
  it('lưu request ID cùng outbox trong transaction webhook', async () => {
    const repository = {
      processCassoTransaction: jest.fn().mockResolvedValue({
        outcome: 'PROCESSED',
        paymentId: '4ca949f2-005b-4a1a-9168-6519f0a19777',
      }),
    };
    const signature = { verify: jest.fn().mockReturnValue(true) };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const service = new PaymentService(
      repository as never,
      {} as never,
      signature as never,
      config as unknown as ConfigService,
    );

    await service.handleCassoWebhook(
      {
        error: 0,
        data: {
          id: 'casso-1',
          description: 'NRP1234567890ABCDEF',
          amount: 125_000,
          accountNumber: '123456789',
          transactionDateTime: '2026-08-24 10:00:00',
        },
      },
      't=1787540400000,v1=signature',
      'req-payment',
    );

    expect(repository.processCassoTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-payment' }),
    );
  });
});
