import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../interfaces/request-context.interface';
import { GatewaySignatureService } from '../security/gateway-signature.service';
import {
  createQrRequestContext,
  releaseLinksRequestContext,
} from '../security/payment-request-context';
import { userIdOf } from '../utils/user.util';

// Mã đơn là ObjectId nên đường dẫn không cần giải mã; controller kiểm lại định dạng.
const RELEASE_LINKS_PATH = /\/orders\/([^/]+)\/release-links$/;

@Injectable()
export class GatewayAuthGuard implements CanActivate {
  constructor(private readonly signatureService: GatewaySignatureService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const payload = request.header('x-user-payload');
    if (!payload) {
      throw new UnauthorizedException('Thiếu thông tin định danh người dùng');
    }

    this.signatureService.assertTrusted({
      payload,
      requestId: request.header('x-request-id'),
      timestamp: request.header('x-user-timestamp'),
      signature: request.header('x-user-signature'),
      context: this.requestContext(request),
    });

    try {
      const parsed = JSON.parse(
        Buffer.from(payload, 'base64').toString('utf8'),
      ) as AuthenticatedUser;
      if (!userIdOf(parsed)) {
        throw new Error('missing user id');
      }
      request.user = parsed;
      return true;
    } catch {
      throw new UnauthorizedException('Thông tin định danh không hợp lệ');
    }
  }

  private requestContext(request: AuthenticatedRequest): string | undefined {
    if (request.method !== 'POST') {
      return undefined;
    }
    const body: unknown = request.body;
    const record =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    if (request.path.endsWith('/create-qr')) {
      return createQrRequestContext(
        record.orderId,
        record.orderUserId,
        record.amount,
      );
    }
    const release = RELEASE_LINKS_PATH.exec(request.path);
    if (release) {
      return releaseLinksRequestContext(release[1], record.reason);
    }
    return undefined;
  }
}
