import { createHmac, randomBytes, randomUUID } from 'node:crypto';

const baseUrl = (
  process.env.PAYMENT_SMOKE_BASE_URL ?? 'http://127.0.0.1:5006'
).replace(/\/+$/, '');
const internalSecret = required('PAYMENT_INTERNAL_SECRET');
const checksumKey = required('PAYOS_CHECKSUM_KEY');
const amount = positiveInteger(process.env.PAYMENT_SMOKE_AMOUNT ?? '125000');
const orderId =
  process.env.PAYMENT_SMOKE_ORDER_ID ?? randomBytes(12).toString('hex');
const userId =
  process.env.PAYMENT_SMOKE_USER_ID ?? randomBytes(12).toString('hex');
const user = { _id: userId, role: 'user' };
const userPayload = Buffer.from(JSON.stringify(user)).toString('base64');

const tamperedResponse = await fetch(`${baseUrl}/api/payment/create-qr`, {
  method: 'POST',
  headers: gatewayHeaders(
    'smoke-tampered',
    createContext(orderId, userId, amount),
  ),
  body: JSON.stringify({ orderId, orderUserId: userId, amount: 1 }),
});
assert(
  tamperedResponse.status === 401,
  `Request sửa amount phải bị từ chối, thực tế HTTP ${tamperedResponse.status}`,
);

const createResponse = await fetch(`${baseUrl}/api/payment/create-qr`, {
  method: 'POST',
  headers: gatewayHeaders(
    'smoke-create',
    createContext(orderId, userId, amount),
  ),
  body: JSON.stringify({ orderId, orderUserId: userId, amount }),
});
const created = await json(createResponse);
assert(createResponse.ok, `Tạo QR thất bại: ${JSON.stringify(created)}`);
assert(created.status === 'PENDING', 'Payment mới phải ở trạng thái PENDING');
assert(created.amount === amount, 'Payment không lưu đúng amount');

assert(
  Number.isSafeInteger(created.orderCode) && created.checkoutUrl,
  'Payment mới phải có orderCode và checkoutUrl của PayOS',
);

const mismatchWebhook = payosWebhook({
  orderCode: created.orderCode,
  amount: amount + 1,
  reference: `SMOKE-MISMATCH-${randomUUID()}`,
});
const mismatchResponse = await fetch(`${baseUrl}/api/payment/webhooks/payos`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(mismatchWebhook),
});
const mismatchResult = await json(mismatchResponse);
assert(
  mismatchResponse.ok && mismatchResult.reviewRequired === 1,
  `Webhook sai tiền phải chờ đối soát: ${JSON.stringify(mismatchResult)}`,
);

const pendingResponse = await fetch(
  `${baseUrl}/api/payment/payments/${created.paymentId}`,
  { headers: gatewayHeaders('smoke-after-mismatch') },
);
const pending = await json(pendingResponse);
assert(
  pendingResponse.ok && pending.status === 'PENDING',
  `Webhook sai tiền không được khóa intent: ${JSON.stringify(pending)}`,
);

const webhook = payosWebhook({
  orderCode: created.orderCode,
  amount,
  reference: `SMOKE-${randomUUID()}`,
});
const webhookResponses = await Promise.all(
  [1, 2].map(() =>
    fetch(`${baseUrl}/api/payment/webhooks/payos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhook),
    }),
  ),
);
const webhookResults = await Promise.all(webhookResponses.map(json));
assert(
  webhookResponses.every((response) => response.ok),
  `Webhook thất bại: ${JSON.stringify(webhookResults)}`,
);
const processed = webhookResults.reduce(
  (total, result) => total + Number(result.processed ?? 0),
  0,
);
const duplicate = webhookResults.reduce(
  (total, result) => total + Number(result.duplicate ?? 0),
  0,
);
assert(processed === 1, `Cần đúng 1 webhook PROCESSED, thực tế ${processed}`);
assert(duplicate === 1, `Cần đúng 1 webhook DUPLICATE, thực tế ${duplicate}`);

const statusResponse = await fetch(
  `${baseUrl}/api/payment/payments/${created.paymentId}`,
  { headers: gatewayHeaders('smoke-status') },
);
const status = await json(statusResponse);
assert(statusResponse.ok, `Đọc payment thất bại: ${JSON.stringify(status)}`);
assert(status.status === 'SUCCESS', 'Payment chưa chuyển sang SUCCESS');

console.log(
  JSON.stringify(
    {
      ok: true,
      orderId,
      paymentId: created.paymentId,
      tamperedRequestStatus: tamperedResponse.status,
      mismatch: {
        reviewRequired: mismatchResult.reviewRequired,
        paymentStatus: pending.status,
      },
      webhook: { processed, duplicate },
      finalStatus: status.status,
    },
    null,
    2,
  ),
);

function gatewayHeaders(requestId, context) {
  const timestampValue = Date.now().toString();
  const message = context
    ? `${timestampValue}.${requestId}.${userPayload}.${context}`
    : `${timestampValue}.${requestId}.${userPayload}`;
  return {
    'content-type': 'application/json',
    'x-request-id': requestId,
    'x-user-payload': userPayload,
    'x-user-timestamp': timestampValue,
    'x-user-signature': createHmac('sha256', internalSecret)
      .update(message)
      .digest('hex'),
  };
}

/** Webhook giống PayOS gửi, ký bằng checksum key theo chuỗi `key=value` sắp theo khoá. */
function payosWebhook({ orderCode, amount: paidAmount, reference }) {
  const data = {
    orderCode,
    amount: paidAmount,
    description: 'SMOKE',
    accountNumber: '0000000000',
    reference,
    transactionDateTime: new Date(Date.now() + 7 * 3_600_000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' '),
    currency: 'VND',
    paymentLinkId: `smoke-${orderCode}`,
    code: '00',
    desc: 'success',
  };
  const signed = Object.keys(data)
    .sort()
    .map((key) => `${key}=${data[key]}`)
    .join('&');
  return {
    code: '00',
    desc: 'success',
    success: true,
    data,
    signature: createHmac('sha256', checksumKey).update(signed).digest('hex'),
  };
}

function createContext(targetOrderId, targetOrderUserId, targetAmount) {
  return JSON.stringify([
    'payment.create-qr.v2',
    targetOrderId,
    targetOrderUserId,
    targetAmount,
  ]);
}

async function json(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `Response không phải JSON (HTTP ${response.status}): ${text}`,
    );
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Thiếu biến môi trường ${name}`);
  }
  return value;
}

function positiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`PAYMENT_SMOKE_AMOUNT không hợp lệ: ${value}`);
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
