const CREATE_QR_CONTEXT_VERSION = 'payment.create-qr.v2';

/**
 * Gắn các trường thanh toán có thể đổi vào HMAC của Gateway, để chữ ký danh tính
 * bị bắt được không thể dùng lại cho đơn hoặc số tiền khác.
 */
export function createQrRequestContext(
  orderId: unknown,
  orderUserId: unknown,
  amount: unknown,
): string {
  return JSON.stringify([
    CREATE_QR_CONTEXT_VERSION,
    orderId,
    orderUserId,
    amount,
  ]);
}
