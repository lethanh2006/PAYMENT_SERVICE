import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { UnprocessableMessage } from '../rabbitmq/rabbitmq.service';
import type { RefundCase } from './refund.repository';
import { RefundService } from './refund.service';

const PAYMENT_ID = 'b0f1d5a4-8a43-4d5c-9a4f-36e3d7f0c001';
const CASE_ID = 'c0f1d5a4-8a43-4d5c-9a4f-36e3d7f0c002';
const cashier = { _id: '507f1f77bcf86cd799439013', role: 'CASHIER' };
const customer = { _id: '507f1f77bcf86cd799439012', role: 'user' };

function refundCase(overrides: Partial<RefundCase> = {}): RefundCase {
  return {
    id: CASE_ID,
    providerEventId: 'link-1:FT2',
    paymentId: PAYMENT_ID,
    orderId: '507f1f77bcf86cd799439011',
    amount: 45_000,
    reason: 'Đơn đã hủy nhưng khách vẫn chuyển khoản, cần hoàn tiền',
    source: 'ORDER_UNAPPLIED',
    status: 'REFUNDED',
    resolvedBy: cashier._id,
    resolutionNote: null,
    resolvedAt: new Date('2026-11-11T03:00:00.000Z'),
    createdAt: new Date('2026-11-11T02:00:00.000Z'),
    ...overrides,
  };
}

function setup() {
  const refunds = {
    list: jest.fn().mockResolvedValue([refundCase({ status: 'OPEN' })]),
    resolve: jest
      .fn()
      .mockResolvedValue({ outcome: 'RESOLVED', refundCase: refundCase() }),
    openForUnappliedPayment: jest.fn().mockResolvedValue('OPENED'),
  };
  return { service: new RefundService(refunds as never), refunds };
}

function unapplied(data: Record<string, unknown>) {
  return { eventType: 'canteen.payment.unapplied.v1', version: 1, data };
}

describe('RefundService', () => {
  it('chỉ nhân viên (admin, manager, cashier) được xem và chốt hồ sơ', async () => {
    const { service, refunds } = setup();

    await expect(service.list({ limit: 50 }, customer)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service.resolve(CASE_ID, { outcome: 'REFUNDED' }, customer),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(refunds.resolve).not.toHaveBeenCalled();

    await expect(service.list({ limit: 50 }, cashier)).resolves.toHaveLength(1);
  });

  it('chốt hồ sơ, ghi người chốt và ghi chú đã cắt khoảng trắng', async () => {
    const { service, refunds } = setup();

    const result = await service.resolve(
      CASE_ID,
      { outcome: 'REFUNDED', note: '  Đã chuyển lại qua VCB  ' },
      cashier,
    );

    expect(refunds.resolve).toHaveBeenCalledWith(
      CASE_ID,
      'REFUNDED',
      cashier._id,
      'Đã chuyển lại qua VCB',
    );
    expect(result).toMatchObject({ refundId: CASE_ID, status: 'REFUNDED' });
  });

  it('hồ sơ đã chốt thì trả 409, không có thì 404', async () => {
    const { service, refunds } = setup();
    refunds.resolve.mockResolvedValueOnce({
      outcome: 'ALREADY_RESOLVED',
      refundCase: refundCase(),
    });
    await expect(
      service.resolve(CASE_ID, { outcome: 'DISMISSED' }, cashier),
    ).rejects.toBeInstanceOf(ConflictException);

    refunds.resolve.mockResolvedValueOnce({ outcome: 'NOT_FOUND' });
    await expect(
      service.resolve(CASE_ID, { outcome: 'DISMISSED' }, cashier),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('mở hồ sơ từ sự kiện Canteen theo mã payment và lý do', async () => {
    const { service, refunds } = setup();

    await service.recordUnapplied(
      unapplied({ paymentId: PAYMENT_ID, reason: ' Đơn đã hủy ' }),
    );

    expect(refunds.openForUnappliedPayment).toHaveBeenCalledWith(
      PAYMENT_ID,
      'Đơn đã hủy',
    );
  });

  it('sự kiện trùng không phải lỗi: không ném để message không bị thử lại', async () => {
    const { service, refunds } = setup();
    refunds.openForUnappliedPayment.mockResolvedValue('DUPLICATE');

    await expect(
      service.recordUnapplied(unapplied({ paymentId: PAYMENT_ID })),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['sai loại sự kiện', { eventType: 'payment.succeeded.v1', data: {} }],
    ['thiếu data', { eventType: 'canteen.payment.unapplied.v1' }],
    ['paymentId không phải UUID', unapplied({ paymentId: 'abc' })],
  ])('message %s vào hàng dead', async (_case, message) => {
    const { service } = setup();

    await expect(service.recordUnapplied(message)).rejects.toBeInstanceOf(
      UnprocessableMessage,
    );
  });

  it('payment không tồn tại thì vào hàng dead thay vì thử lại mãi', async () => {
    const { service, refunds } = setup();
    refunds.openForUnappliedPayment.mockResolvedValue('UNKNOWN_PAYMENT');

    await expect(
      service.recordUnapplied(unapplied({ paymentId: PAYMENT_ID })),
    ).rejects.toBeInstanceOf(UnprocessableMessage);
  });
});
