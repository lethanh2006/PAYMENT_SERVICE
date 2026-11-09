import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  PaymentEntity,
  PaymentStatus,
} from '../../database/entities/payment.entity';
import { parsePayosDate, PaymentService } from './payment.service';

const ORDER_ID = '507f1f77bcf86cd799439011';
const OWNER_ID = '507f1f77bcf86cd799439012';
const owner = { _id: OWNER_ID, role: 'user' };

function payment(overrides: Partial<PaymentEntity> = {}): PaymentEntity {
  return Object.assign(new PaymentEntity(), {
    id: 'b0f1d5a4-8a43-4d5c-9a4f-36e3d7f0c001',
    orderId: ORDER_ID,
    userId: OWNER_ID,
    paymentCode: '176200000012345',
    amount: 45_000,
    currency: 'VND',
    status: PaymentStatus.PENDING,
    paymentMethod: 'PAYOS',
    transferDescription: 'NRP012345',
    qrCode: '000201...',
    checkoutUrl: 'https://pay.payos.vn/web/link-1',
    expiresAt: new Date(Date.now() + 60_000),
    paidAt: null,
    createdAt: new Date(),
    ...overrides,
  });
}

function setup() {
  const payments = {
    findActiveForOrder: jest.fn().mockResolvedValue(null),
    createOrReuse: jest.fn((candidate: PaymentEntity) =>
      Promise.resolve({
        payment: Object.assign(candidate, { createdAt: new Date() }),
        supersededLinkId: null as string | null,
      }),
    ),
    processPayosTransaction: jest
      .fn()
      .mockResolvedValue({ outcome: 'PROCESSED', paymentId: 'p' }),
  };
  const payosClient = {
    createPaymentLink: jest.fn().mockResolvedValue({
      paymentLinkId: 'link-1',
      checkoutUrl: 'https://pay.payos.vn/web/link-1',
      qrCode: '000201...',
      accountNumber: '0123456789',
    }),
    cancelPaymentLink: jest.fn().mockResolvedValue(undefined),
    verifyWebhook: jest.fn((payload: { data: unknown }) => payload.data),
  };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const service = new PaymentService(
    payments as never,
    payosClient as never,
    config as unknown as ConfigService,
  );
  return { service, payments, payosClient };
}

describe('PaymentService với PayOS', () => {
  const dto = { orderId: ORDER_ID, orderUserId: OWNER_ID, amount: 45_000 };

  it('dùng lại link còn hạn cùng số tiền, không gọi PayOS lần nữa', async () => {
    const { service, payments, payosClient } = setup();
    payments.findActiveForOrder.mockResolvedValue(payment());

    const result = await service.createQr(dto, owner);

    expect(result.checkoutUrl).toBe('https://pay.payos.vn/web/link-1');
    expect(payosClient.createPaymentLink).not.toHaveBeenCalled();
  });

  it('tạo link PayOS mới với nội dung chuyển khoản tối đa 9 ký tự', async () => {
    const { service, payments, payosClient } = setup();

    const result = await service.createQr(dto, owner);

    const [input] = payosClient.createPaymentLink.mock.calls[0] as [
      { orderCode: number; amount: number; description: string },
    ];
    expect(Number.isSafeInteger(input.orderCode)).toBe(true);
    expect(input.amount).toBe(45_000);
    expect(input.description).toMatch(/^NRP\d{6}$/);
    expect(payments.createOrReuse).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentCode: String(input.orderCode),
        paymentLinkId: 'link-1',
        provider: 'PAYOS',
      }),
    );
    expect(result).toMatchObject({
      orderCode: input.orderCode,
      status: 'PENDING',
      qrCode: '000201...',
    });
  });

  it('huỷ link vừa tạo khi request song song đã giữ link khác cho đơn', async () => {
    const { service, payments, payosClient } = setup();
    payments.createOrReuse.mockResolvedValue({
      payment: payment({ id: 'existing' }),
      supersededLinkId: null,
    });

    const result = await service.createQr(dto, owner);
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.paymentId).toBe('existing');
    expect(payosClient.cancelPaymentLink).toHaveBeenCalledWith(
      'link-1',
      expect.any(String),
    );
  });

  it('huỷ link cũ còn hạn khi đơn đổi số tiền và phải cấp link mới', async () => {
    const { service, payments, payosClient } = setup();
    payments.createOrReuse.mockImplementation((candidate: PaymentEntity) =>
      Promise.resolve({
        payment: Object.assign(candidate, { createdAt: new Date() }),
        supersededLinkId: 'link-old',
      }),
    );

    await service.createQr(dto, owner);
    await new Promise((resolve) => setImmediate(resolve));

    expect(payosClient.cancelPaymentLink).toHaveBeenCalledTimes(1);
    expect(payosClient.cancelPaymentLink).toHaveBeenCalledWith(
      'link-old',
      expect.any(String),
    );
  });

  it('webhook và đối soát cho cùng mã sự kiện, cùng mã băm với một giao dịch', async () => {
    const { service, payments } = setup();
    const transaction = {
      orderCode: 176200000012345,
      paymentLinkId: 'link-1',
      reference: 'FT1',
      amount: 45_000,
      transactionDateTime: '2026-11-04 10:15:00',
    };

    await service.handlePayosWebhook(
      {
        code: '00',
        data: { code: '00', desc: 'success', currency: 'VND', ...transaction },
      },
      'req',
    );
    await service.recordPayosTransaction(transaction, null, null);

    const [[fromWebhook], [fromReconciliation]] = payments
      .processPayosTransaction.mock.calls as [
      [{ providerEventId: string; payloadHash: string }],
      [{ providerEventId: string; payloadHash: string }],
    ];
    expect(fromReconciliation.providerEventId).toBe('link-1:FT1');
    expect(fromReconciliation.providerEventId).toBe(
      fromWebhook.providerEventId,
    );
    expect(fromReconciliation.payloadHash).toBe(fromWebhook.payloadHash);
  });

  it('từ chối webhook sai chữ ký', async () => {
    const { service, payosClient, payments } = setup();
    payosClient.verifyWebhook.mockReturnValue(null);

    await expect(
      service.handlePayosWebhook({ data: {} }, 'req'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(payments.processPayosTransaction).not.toHaveBeenCalled();
  });

  it('đổi webhook PayOS sang giao dịch theo orderCode và giờ Việt Nam', async () => {
    const { service, payments } = setup();

    await service.handlePayosWebhook(
      {
        code: '00',
        data: {
          code: '00',
          orderCode: 176200000012345,
          amount: 45_000,
          reference: 'FT1',
          paymentLinkId: 'link-1',
          transactionDateTime: '2026-11-04 10:15:00',
        },
      },
      'req',
    );

    expect(payments.processPayosTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        providerEventId: 'link-1:FT1',
        paymentCode: '176200000012345',
        amount: 45_000,
        paidAt: new Date('2026-11-04T03:15:00.000Z'),
        providerValidationError: null,
      }),
    );
  });

  it('đưa giao dịch PayOS không thành công sang đối soát', async () => {
    const { service, payments } = setup();

    await service.handlePayosWebhook(
      { code: '00', data: { code: '01', orderCode: 1, amount: 1 } },
      undefined,
    );

    expect(payments.processPayosTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        providerValidationError: 'PayOS báo giao dịch không thành công',
      }),
    );
  });

  it.each([
    ['2026-02-30 10:00:00', null],
    ['2026-11-04T10:00:00Z', null],
    ['abc', null],
    ['2026-11-04 23:30:00', new Date('2026-11-04T16:30:00.000Z')],
  ])('đọc thời gian PayOS %s', (value, expected) => {
    expect(parsePayosDate(value)).toEqual(expected);
  });
});
