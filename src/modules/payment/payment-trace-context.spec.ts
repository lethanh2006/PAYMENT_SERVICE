import { ConfigService } from '@nestjs/config';
import { injectTraceHeaders } from '@nrapp/observability';
import { PaymentService } from './payment.service';

jest.mock('@nrapp/observability', () => ({
  ...jest.requireActual<typeof import('@nrapp/observability')>(
    '@nrapp/observability',
  ),
  injectTraceHeaders: jest.fn(),
}));

describe('Payment outbox trace context', () => {
  afterEach(() => jest.clearAllMocks());

  it('lưu W3C context cùng outbox trong transaction webhook', async () => {
    jest.mocked(injectTraceHeaders).mockReturnValue({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'vendor=value',
    });
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
      'req-trace',
    );

    expect(repository.processCassoTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-trace',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        tracestate: 'vendor=value',
      }),
    );
  });
});
