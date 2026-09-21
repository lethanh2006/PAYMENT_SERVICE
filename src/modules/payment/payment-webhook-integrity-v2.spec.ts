import type { ConfigService } from '@nestjs/config';
import type { PaymentEntity } from '../database/entities/payment.entity';
import type { CassoSignatureService } from './casso-signature.service';
import {
  type CassoProcessingResult,
  type CassoTransactionInput,
  validateCassoTransaction,
} from './payment.repository';
import { PaymentService } from './payment.service';

describe('Payment webhook integrity v2', () => {
  function setupService() {
    const processCassoTransaction = jest.fn(
      (input: CassoTransactionInput): Promise<CassoProcessingResult> =>
        Promise.resolve({
          outcome: input.providerValidationError
            ? 'REVIEW_REQUIRED'
            : 'PROCESSED',
          paymentId: input.providerValidationError ? null : 'payment-id',
          ...(input.providerValidationError
            ? { reason: input.providerValidationError }
            : {}),
        }),
    );
    const repository = { processCassoTransaction };
    const signatureService = { verify: jest.fn().mockReturnValue(true) };
    const configService = {
      get: jest.fn((key: string): string | undefined => {
        if (key === 'PAYMENT_INTENT_TTL_MINUTES') return '15';
        if (key === 'PAYMENT_CODE_PREFIX') return 'NRP';
        if (key === 'CASSO_TIMEZONE_OFFSET') return '+07:00';
        return undefined;
      }),
    };
    const service = new PaymentService(
      repository as never,
      {} as never,
      signatureService as unknown as CassoSignatureService,
      configService as unknown as ConfigService,
    );

    return { processCassoTransaction, service };
  }

  function transaction(id: number, timestamp = '2026-08-24 10:30:00') {
    return {
      id,
      description: 'Thanh toan NRP1234567890ABCDEF',
      amount: 125_000,
      accountNumber: '123456789',
      transactionDateTime: timestamp,
      bankName: 'Ngân hàng thử nghiệm',
    };
  }

  it('đưa timestamp provider thiếu hoặc sai sang REVIEW_REQUIRED', async () => {
    const { processCassoTransaction, service } = setupService();

    const results = await service.handleCassoWebhook(
      { error: 0, data: transaction(1, '2026-02-30 10:30:00') },
      't=1787560000000,v1=signature',
      'request-id',
    );

    expect(results[0]).toMatchObject({ outcome: 'REVIEW_REQUIRED' });
    expect(processCassoTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paidAt: null,
        providerValidationError: 'Thời gian giao dịch Casso không hợp lệ',
      }),
    );
  });

  it('hash từng giao dịch ổn định, không phụ thuộc webhook batch', async () => {
    const { processCassoTransaction, service } = setupService();
    const first = transaction(1);
    const second = transaction(2);

    await service.handleCassoWebhook(
      { error: 0, data: [first, second] },
      't=1787560000000,v1=signature',
      'request-id',
    );
    const firstBatchHash = processCassoTransaction.mock.calls[0][0].payloadHash;
    const secondBatchHash =
      processCassoTransaction.mock.calls[1][0].payloadHash;
    expect(firstBatchHash).not.toBe(secondBatchHash);

    processCassoTransaction.mockClear();
    const reordered = {
      bankName: first.bankName,
      transactionDateTime: first.transactionDateTime,
      accountNumber: first.accountNumber,
      amount: first.amount,
      description: first.description,
      id: first.id,
    };
    await service.handleCassoWebhook(
      { data: reordered, error: 0 },
      't=1787560000000,v1=signature',
      'request-id',
    );
    const singleHash = processCassoTransaction.mock.calls[0][0].payloadHash;
    expect(singleHash).toBe(firstBatchHash);
  });

  it('repository ưu tiên lỗi xác thực provider trước khi ghi SUCCESS', () => {
    const input: CassoTransactionInput = {
      providerEventId: 'event-id',
      paymentCode: 'NRP1234567890ABCDEF',
      amount: 125_000,
      destinationAccount: '123456789',
      providerReference: null,
      payloadHash: 'a'.repeat(64),
      signatureTimestamp: null,
      metadata: {},
      paidAt: null,
      providerValidationError: 'Thời gian giao dịch Casso không hợp lệ',
      requestId: null,
    };

    expect(validateCassoTransaction({} as PaymentEntity, input)).toBe(
      input.providerValidationError,
    );
  });
});
