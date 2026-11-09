import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PayosPaymentRequestFields {
  amount: number;
  cancelUrl: string;
  description: string;
  orderCode: number;
  returnUrl: string;
}

/**
 * Chuỗi `key=value&...` theo khoá tăng dần mà PayOS ký cho dữ liệu webhook và response:
 * null/undefined thành chuỗi rỗng, mảng được JSON hoá sau khi sắp khoá từng phần tử
 * (đúng thuật toán của SDK chính thức, nếu lệch thì chữ ký không bao giờ khớp).
 */
export function payosDataString(data: Record<string, unknown>): string {
  return Object.keys(data)
    .sort()
    .filter((key) => data[key] !== undefined)
    .map((key) => {
      let value = data[key];
      if (Array.isArray(value)) {
        value = JSON.stringify(value.map((item) => sortKeys(item)));
      }
      if (
        value === null ||
        value === undefined ||
        value === 'null' ||
        value === 'undefined'
      ) {
        value = '';
      }
      return `${key}=${String(value)}`;
    })
    .join('&');
}

export function signPayosData(
  data: Record<string, unknown>,
  checksumKey: string,
): string {
  return hmac(payosDataString(data), checksumKey);
}

/** Yêu cầu tạo link chỉ ký năm trường cố định, không ký toàn bộ body. */
export function signPayosPaymentRequest(
  fields: PayosPaymentRequestFields,
  checksumKey: string,
): string {
  const { amount, cancelUrl, description, orderCode, returnUrl } = fields;
  return hmac(
    `amount=${amount}&cancelUrl=${cancelUrl}&description=${description}&orderCode=${orderCode}&returnUrl=${returnUrl}`,
    checksumKey,
  );
}

export function verifyPayosData(
  data: Record<string, unknown>,
  signature: unknown,
  checksumKey: string,
): boolean {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) {
    return false;
  }
  const expected = Buffer.from(signPayosData(data, checksumKey), 'hex');
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

function hmac(message: string, key: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const source = value as Record<string, unknown>;
  return Object.keys(source)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = source[key];
      return sorted;
    }, {});
}
