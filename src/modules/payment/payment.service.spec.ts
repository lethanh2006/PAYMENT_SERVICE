import type { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import {
  PaymentEntity,
  PaymentStatus,
} from '../database/entities/payment.entity';
import type { CassoSignatureService } from './casso-signature.service';
import type { PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';
import type { BuildVietQrInput, VietQrService } from './vietqr.service';

function config(): ConfigService {
  const values: Record<string, string> = {
    PAYMENT_INTENT_TTL_MINUTES: '15',
    PAYMENT_CODE_PREFIX: 'NRP',
    CASSO_TIMEZONE_OFFSET: '+07:00',
  };
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('PaymentService', () => {
  const createOrReuse = jest.fn((payment: PaymentEntity) =>
    Promise.resolve(
      Object.assign(payment, {
        createdAt: new Date('2026-08-20T00:00:00.000Z'),
        updatedAt: new Date('2026-08-20T00:00:00.000Z'),
      }),
    ),
  );
  const processCassoTransaction = jest.fn(() =>
    Promise.resolve({
      outcome: 'PROCESSED' as const,
      paymentId: '93466679-ed84-4e32-b401-a8a8a8a8a8a8',
    }),
  );
  const repository = {
    createOrReuse,
    findById: jest.fn(),
    findLatestByOrder: jest.fn(),
    findHistory: jest.fn(),
    processCassoTransaction,
  } as unknown as jest.Mocked<PaymentRepository>;
  const buildQrUrl = jest.fn((input: BuildVietQrInput) => {
    void input;
    return 'https://img.vietqr.io/payment.jpg';
  });
  const vietQr = {
    buildQrUrl,
    buildTransferDescription: jest.fn((code: string) => `NRAPP PAY ${code}`),
    getDestinationAccount: jest.fn(() => '0123456789'),
  } as unknown as jest.Mocked<VietQrService>;
  const signature = {
    verify: jest.fn(() => true),
  } as unknown as jest.Mocked<CassoSignatureService>;

  let service: PaymentService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PaymentService(repository, vietQr, signature, config());
  });

  it('tạo intent VietQR từ amount đã được Gateway xác minh', async () => {
    const response = await service.createQr(
      {
        orderId: '66c6a6a6a6a6a6a6a6a6a6a6',
        orderUserId: '66c6b6b6b6b6b6b6b6b6b6b6',
        amount: 50_000,
      },
      { _id: '66c6b6b6b6b6b6b6b6b6b6b6', role: 'user' },
    );

    expect(buildQrUrl).toHaveBeenCalledTimes(1);
    const qrInput = buildQrUrl.mock.calls[0][0];
    expect(qrInput.amount).toBe(50_000);
    expect(qrInput.reference).toMatch(/^NRP[A-F0-9]{16}$/);
    expect(createOrReuse).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: '66c6a6a6a6a6a6a6a6a6a6a6',
        userId: '66c6b6b6b6b6b6b6b6b6b6b6',
        amount: 50_000,
        status: PaymentStatus.PENDING,
      }),
    );
    expect(response).toEqual(
      expect.objectContaining({
        orderId: '66c6a6a6a6a6a6a6a6a6a6a6',
        amount: 50_000,
        currency: 'VND',
      }),
    );
  });

  it('lưu chủ đơn thay vì nhân viên tạo QR hộ', async () => {
    await service.createQr(
      {
        orderId: '66c6a6a6a6a6a6a6a6a6a6a6',
        orderUserId: '66c6b6b6b6b6b6b6b6b6b6b6',
        amount: 50_000,
      },
      { _id: '66c6c6c6c6c6c6c6c6c6c6c6', role: 'cashier' },
    );

    expect(createOrReuse).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '66c6b6b6b6b6b6b6b6b6b6b6',
      }),
    );
  });

  it('từ chối người thường tạo QR cho đơn của người khác', async () => {
    await expect(
      service.createQr(
        {
          orderId: '66c6a6a6a6a6a6a6a6a6a6a6',
          orderUserId: '66c6b6b6b6b6b6b6b6b6b6b6',
          amount: 50_000,
        },
        { _id: '66c6c6c6c6c6c6c6c6c6c6c6', role: 'user' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(createOrReuse).not.toHaveBeenCalled();
  });

  it('dùng amount thực nhận từ Casso và parse mã trong mô tả URL-encoded', async () => {
    const payload = {
      error: 0,
      data: {
        id: 123456,
        reference: 'BANK-REF',
        description: 'PREFIX%20NRP1234567890ABCDEF%20SUFFIX',
        amount: 75_000,
        accountNumber: '0123456789',
        transactionDateTime: '2026-08-20 12:30:00',
        bankAbbreviation: 'OCB',
      },
    };

    const result = await service.handleCassoWebhook(
      payload,
      Buffer.from(JSON.stringify(payload)),
      `t=${Date.now()},v1=${'a'.repeat(128)}`,
      'request-1',
    );

    expect(processCassoTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        providerEventId: '123456',
        paymentCode: 'NRP1234567890ABCDEF',
        amount: 75_000,
        destinationAccount: '0123456789',
        providerReference: 'BANK-REF',
        requestId: 'request-1',
      }),
    );
    expect(result).toEqual([expect.objectContaining({ outcome: 'PROCESSED' })]);
  });

  it('từ chối webhook trước khi ghi DB nếu chữ ký không hợp lệ', async () => {
    signature.verify.mockReturnValueOnce(false);

    await expect(
      service.handleCassoWebhook(
        { error: 0, data: {} },
        Buffer.from('{}'),
        'invalid',
        'request-2',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(processCassoTransaction).not.toHaveBeenCalled();
  });
});
