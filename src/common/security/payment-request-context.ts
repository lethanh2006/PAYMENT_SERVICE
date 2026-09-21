const CREATE_QR_CONTEXT_VERSION = 'payment.create-qr.v2';

/**
 * Binds the mutable payment fields to the Gateway HMAC. A captured identity
 * signature therefore cannot be replayed with another order or amount.
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
