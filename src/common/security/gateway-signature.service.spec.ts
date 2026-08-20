import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { GatewaySignatureService } from './gateway-signature.service';
import { createQrRequestContext } from './payment-request-context';

const SECRET = 'payment_internal_test_secret_longer_than_32_chars';

function createService(): GatewaySignatureService {
  const values: Record<string, string> = {
    PAYMENT_INTERNAL_SECRET: SECRET,
    PAYMENT_REQUIRE_SIGNATURE: 'true',
    PAYMENT_SIGNATURE_MAX_AGE_MS: '300000',
  };
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  const service = new GatewaySignatureService(config);
  service.onModuleInit();
  return service;
}

function signature(
  timestamp: string,
  requestId: string,
  payload: string,
  context?: string,
): string {
  const message = context
    ? `${timestamp}.${requestId}.${payload}.${context}`
    : `${timestamp}.${requestId}.${payload}`;
  return createHmac('sha256', SECRET).update(message).digest('hex');
}

describe('GatewaySignatureService', () => {
  it('xác thực request tạo QR khi order và amount nằm trong chữ ký', () => {
    const service = createService();
    const timestamp = Date.now().toString();
    const requestId = 'request-create-qr';
    const payload = Buffer.from('{"_id":"user-1"}').toString('base64');
    const context = createQrRequestContext('order-1', 125_000);

    expect(() =>
      service.assertTrusted({
        timestamp,
        requestId,
        payload,
        context,
        signature: signature(timestamp, requestId, payload, context),
      }),
    ).not.toThrow();
  });

  it('từ chối khi amount bị đổi sau lúc Gateway ký', () => {
    const service = createService();
    const timestamp = Date.now().toString();
    const requestId = 'request-tampered';
    const payload = Buffer.from('{"_id":"user-1"}').toString('base64');
    const signedContext = createQrRequestContext('order-1', 125_000);
    const tamperedContext = createQrRequestContext('order-1', 1_000);

    expect(() =>
      service.assertTrusted({
        timestamp,
        requestId,
        payload,
        context: tamperedContext,
        signature: signature(timestamp, requestId, payload, signedContext),
      }),
    ).toThrow(UnauthorizedException);
  });

  it('giữ tương thích chữ ký chỉ đọc không có context', () => {
    const service = createService();
    const timestamp = Date.now().toString();
    const requestId = 'request-read';
    const payload = Buffer.from('{"_id":"user-1"}').toString('base64');

    expect(() =>
      service.assertTrusted({
        timestamp,
        requestId,
        payload,
        signature: signature(timestamp, requestId, payload),
      }),
    ).not.toThrow();
  });
});
