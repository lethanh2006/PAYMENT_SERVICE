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

const RELEASE_LINKS_CONTEXT_VERSION = 'payment.release-links.v1';

/** Lý do một đơn không còn nhận thanh toán online. */
export const RELEASE_REASONS = ['ORDER_CANCELLED', 'PAID_IN_CASH'] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

/**
 * Gateway chỉ ký ngữ cảnh này sau khi Canteen đã huỷ đơn hoặc đã thu tiền mặt, nên chữ ký
 * thay cho việc kiểm quyền: người gọi không tự huỷ được link của đơn khác hay với lý do khác.
 */
export function releaseLinksRequestContext(
  orderId: unknown,
  reason: unknown,
): string {
  return JSON.stringify([RELEASE_LINKS_CONTEXT_VERSION, orderId, reason]);
}

const RESOLVE_REFUND_CONTEXT_VERSION = 'payment.refund-resolve.v1';

/** Gắn mã hồ sơ và kết quả vào chữ ký: chữ ký bị bắt được không dùng để chốt hồ sơ khác hay kết quả khác. */
export function resolveRefundRequestContext(
  caseId: unknown,
  outcome: unknown,
): string {
  return JSON.stringify([RESOLVE_REFUND_CONTEXT_VERSION, caseId, outcome]);
}
