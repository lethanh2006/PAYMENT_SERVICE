import type { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { OutboxEventEntity } from '../database/entities/outbox-event.entity';
import {
  PaymentEntity,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
} from '../database/entities/payment.entity';
import { WebhookProcessingStatus } from '../database/entities/webhook-receipt.entity';
import {
  PaymentRepository,
  type CassoTransactionInput,
} from './payment.repository';

describe('PaymentRepository', () => {
  const payment = Object.assign(new PaymentEntity(), {
    id: '93466679-ed84-4e32-b401-a8a8a8a8a8a8',
    orderId: '66c6a6a6a6a6a6a6a6a6a6a6',
    userId: '66c6b6b6b6b6b6b6b6b6b6b6',
    paymentCode: 'NRP1234567890ABCDEF',
    amount: 125_000,
    currency: 'VND',
    status: PaymentStatus.PENDING,
    paymentMethod: PaymentMethod.VIETQR,
    provider: PaymentProvider.CASSO,
    destinationAccount: '0123456789',
    expiresAt: new Date(Date.now() + 60_000),
    providerTransactionId: null,
    providerReference: null,
    providerMetadata: null,
    reviewReason: null,
    paidAt: null,
  });
  const getOne = jest.fn<Promise<PaymentEntity>, []>();
  const queryBuilder = {
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne,
  };
  const paymentEntityRepository = {
    createQueryBuilder: jest.fn(() => queryBuilder),
  };
  const updateReceipt = jest.fn().mockResolvedValue({ affected: 1 });
  const receiptRepository = { update: updateReceipt };
  const query = jest.fn().mockResolvedValue({
    affected: 1,
    records: [{ id: 'receipt-id' }],
  });
  const createEntity = jest.fn((_entity: unknown, value: unknown) => value);
  const saveEntity = jest.fn((value: unknown) => Promise.resolve(value));
  const manager = {
    queryRunner: { query } as unknown as QueryRunner,
    getRepository: jest.fn((entity: unknown) =>
      entity === PaymentEntity ? paymentEntityRepository : receiptRepository,
    ),
    create: createEntity,
    save: saveEntity,
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn((handler: (value: EntityManager) => unknown) =>
      handler(manager),
    ),
  } as unknown as DataSource;
  const repository = new PaymentRepository(dataSource);

  beforeEach(() => {
    jest.clearAllMocks();
    payment.status = PaymentStatus.PENDING;
    payment.reviewReason = null;
    payment.providerTransactionId = null;
    payment.providerReference = null;
    payment.providerMetadata = null;
    payment.paidAt = null;
    payment.expiresAt = new Date(Date.now() + 60_000);
    getOne.mockResolvedValue(payment);
    query.mockResolvedValue({
      affected: 1,
      records: [{ id: 'receipt-id' }],
    });
  });

  it('giữ intent PENDING sau giao dịch sai tiền để giao dịch đúng kế tiếp thành công', async () => {
    const mismatch = await repository.processCassoTransaction(
      input({ providerEventId: 'casso-mismatch', amount: 1 }),
    );

    expect(mismatch.outcome).toBe('REVIEW_REQUIRED');
    expect(payment.status).toBe(PaymentStatus.PENDING);
    expect(payment.reviewReason).toBeNull();
    expect(saveEntity).not.toHaveBeenCalled();
    expect(updateReceipt).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: WebhookProcessingStatus.REVIEW_REQUIRED,
        paymentId: payment.id,
        failureReason: 'Số tiền thực nhận 1 không khớp số tiền đơn hàng',
      }),
    );

    const valid = await repository.processCassoTransaction(
      input({ providerEventId: 'casso-valid' }),
    );

    expect(valid.outcome).toBe('PROCESSED');
    expect(payment.status).toBe(PaymentStatus.SUCCESS);
    expect(payment.providerTransactionId).toBe('casso-valid');
    expect(createEntity).toHaveBeenCalledWith(
      OutboxEventEntity,
      expect.objectContaining({ eventType: 'payment.succeeded.v1' }),
    );
  });

  it('không đổi intent PENDING thành REVIEW_REQUIRED khi đã quá expiresAt', async () => {
    payment.expiresAt = new Date(Date.now() - 1_000);

    const result = await repository.processCassoTransaction(
      input({ providerEventId: 'casso-expired' }),
    );

    expect(result.outcome).toBe('REVIEW_REQUIRED');
    expect(result.reason).toBe('Thanh toán đã hết hạn');
    expect(payment.status).toBe(PaymentStatus.PENDING);
    expect(payment.reviewReason).toBeNull();
    expect(saveEntity).not.toHaveBeenCalled();
    expect(updateReceipt).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: WebhookProcessingStatus.REVIEW_REQUIRED,
        paymentId: payment.id,
        failureReason: 'Thanh toán đã hết hạn',
      }),
    );
  });
});

function input(
  overrides: Partial<CassoTransactionInput> = {},
): CassoTransactionInput {
  return {
    providerEventId: 'casso-transaction',
    paymentCode: 'NRP1234567890ABCDEF',
    amount: 125_000,
    destinationAccount: '0123456789',
    providerReference: 'BANK-REFERENCE',
    payloadHash: 'a'.repeat(64),
    signatureTimestamp: Date.now().toString(),
    metadata: {},
    paidAt: new Date(),
    requestId: 'request-id',
    ...overrides,
  };
}
