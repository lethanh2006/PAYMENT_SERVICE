import { createHmac, randomBytes, randomUUID } from 'node:crypto';

const baseUrl = (
  process.env.PAYMENT_SMOKE_BASE_URL ?? 'http://127.0.0.1:5006'
).replace(/\/+$/, '');
const internalSecret = required('PAYMENT_INTERNAL_SECRET');
const cassoSecret = required('CASSO_WEBHOOK_SECRET');
const destinationAccount = required('VIETQR_ACCOUNT_NUMBER');
const amount = positiveInteger(process.env.PAYMENT_SMOKE_AMOUNT ?? '125000');
const orderId =
  process.env.PAYMENT_SMOKE_ORDER_ID ?? randomBytes(12).toString('hex');
const userId =
  process.env.PAYMENT_SMOKE_USER_ID ?? randomBytes(12).toString('hex');
const user = { _id: userId, role: 'user' };
const userPayload = Buffer.from(JSON.stringify(user)).toString('base64');

const tamperedResponse = await fetch(`${baseUrl}/api/payment/create-qr`, {
  method: 'POST',
  headers: gatewayHeaders('smoke-tampered', createContext(orderId, amount)),
  body: JSON.stringify({ orderId, amount: 1 }),
});
assert(
  tamperedResponse.status === 401,
  `Request sửa amount phải bị từ chối, thực tế HTTP ${tamperedResponse.status}`,
);

const createResponse = await fetch(`${baseUrl}/api/payment/create-qr`, {
  method: 'POST',
  headers: gatewayHeaders('smoke-create', createContext(orderId, amount)),
  body: JSON.stringify({ orderId, amount }),
});
const created = await json(createResponse);
assert(createResponse.ok, `Tạo QR thất bại: ${JSON.stringify(created)}`);
assert(created.status === 'PENDING', 'Payment mới phải ở trạng thái PENDING');
assert(created.amount === amount, 'Payment không lưu đúng amount');

const paymentCode = String(created.transferContent ?? '')
  .trim()
  .split(/\s+/)
  .at(-1);
assert(paymentCode, 'Không lấy được payment code từ transferContent');

const webhook = {
  error: 0,
  data: {
    id: `smoke-${randomUUID()}`,
    reference: `SMOKE-${randomUUID()}`,
    description: `SMOKE PREFIX ${paymentCode} SMOKE SUFFIX`,
    amount,
    accountNumber: destinationAccount,
    transactionDateTime: new Date().toISOString(),
    bankAbbreviation: 'SMOKE',
  },
};
const timestamp = Date.now().toString();
const cassoSignature = createHmac('sha512', cassoSecret)
  .update(`${timestamp}.${JSON.stringify(sortValue(webhook))}`)
  .digest('hex');
const webhookHeaders = {
  'content-type': 'application/json',
  'x-casso-signature': `t=${timestamp},v1=${cassoSignature}`,
};
const webhookResponses = await Promise.all([
  fetch(`${baseUrl}/api/payment/webhooks/casso`, {
    method: 'POST',
    headers: webhookHeaders,
    body: JSON.stringify(webhook),
  }),
  fetch(`${baseUrl}/api/payment/webhooks/casso`, {
    method: 'POST',
    headers: webhookHeaders,
    body: JSON.stringify(webhook),
  }),
]);
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

function createContext(targetOrderId, targetAmount) {
  return JSON.stringify(['payment.create-qr.v1', targetOrderId, targetAmount]);
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((sorted, key) => {
        sorted[key] = sortValue(value[key]);
        return sorted;
      }, {});
  }
  return value;
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
