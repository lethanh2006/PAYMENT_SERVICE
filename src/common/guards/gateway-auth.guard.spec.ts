import type { ExecutionContext } from '@nestjs/common';

import type { GatewaySignatureService } from '../security/gateway-signature.service';
import {
  createQrRequestContext,
  releaseLinksRequestContext,
} from '../security/payment-request-context';
import { GatewayAuthGuard } from './gateway-auth.guard';

const ORDER_ID = '507f1f77bcf86cd799439011';
const user = Buffer.from(JSON.stringify({ _id: 'u1', role: 'user' })).toString(
  'base64',
);

function contextFor(method: string, path: string, body: unknown) {
  const assertTrusted = jest.fn();
  const guard = new GatewayAuthGuard({
    assertTrusted,
  } as unknown as GatewaySignatureService);
  const request = {
    method,
    path,
    body,
    header: (name: string) => (name === 'x-user-payload' ? user : 'x'),
  };
  guard.canActivate({
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext);
  return (assertTrusted.mock.calls[0] as [{ context?: string }])[0].context;
}

describe('GatewayAuthGuard: ngữ cảnh chữ ký theo route', () => {
  it('create-qr gắn đơn, chủ đơn và số tiền', () => {
    expect(
      contextFor('POST', '/api/payment/create-qr', {
        orderId: ORDER_ID,
        orderUserId: 'u1',
        amount: 45_000,
      }),
    ).toBe(createQrRequestContext(ORDER_ID, 'u1', 45_000));
  });

  it('release-links gắn mã đơn trên đường dẫn và lý do trong body', () => {
    expect(
      contextFor('POST', `/api/payment/orders/${ORDER_ID}/release-links`, {
        reason: 'ORDER_CANCELLED',
      }),
    ).toBe(releaseLinksRequestContext(ORDER_ID, 'ORDER_CANCELLED'));
  });

  it('các route khác chỉ ký danh tính', () => {
    expect(
      contextFor('GET', `/api/payment/orders/${ORDER_ID}`, undefined),
    ).toBeUndefined();
  });
});
