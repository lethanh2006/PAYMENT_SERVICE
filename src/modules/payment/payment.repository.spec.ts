import {
  PaymentEntity,
  PaymentStatus,
} from '../../database/entities/payment.entity';
import {
  type PayosTransactionInput,
  validatePayosTransaction,
} from './payment.repository';

function payment(status: PaymentStatus): PaymentEntity {
  return Object.assign(new PaymentEntity(), { status, amount: 45_000 });
}

const input: PayosTransactionInput = {
  providerEventId: 'link-1:FT1',
  paymentCode: '176200000012345',
  amount: 45_000,
  providerReference: 'FT1',
  payloadHash: 'a'.repeat(64),
  metadata: {},
  paidAt: new Date(),
  providerValidationError: null,
  requestId: null,
};

describe('validatePayosTransaction', () => {
  it.each([PaymentStatus.PENDING, PaymentStatus.EXPIRED])(
    'ghi nhận tiền về cho link %s vì PayOS đã tự khoá link quá hạn',
    (status) => {
      expect(validatePayosTransaction(payment(status), input)).toBeNull();
    },
  );

  it('ưu tiên lỗi provider trước mọi kiểm tra khác', () => {
    expect(
      validatePayosTransaction(payment(PaymentStatus.PENDING), {
        ...input,
        providerValidationError: 'PayOS báo giao dịch không thành công',
      }),
    ).toBe('PayOS báo giao dịch không thành công');
  });

  it.each([
    [PaymentStatus.SUCCESS, 'Thanh toán đã thành công bằng một giao dịch khác'],
    [PaymentStatus.FAILED, 'Thanh toán đang ở trạng thái FAILED'],
  ])('chặn payment %s', (status, reason) => {
    expect(validatePayosTransaction(payment(status), input)).toBe(reason);
  });

  it('chặn số tiền lệch với đơn', () => {
    expect(
      validatePayosTransaction(payment(PaymentStatus.PENDING), {
        ...input,
        amount: 1,
      }),
    ).toBe('Số tiền thực nhận 1 không khớp số tiền đơn hàng');
  });
});
