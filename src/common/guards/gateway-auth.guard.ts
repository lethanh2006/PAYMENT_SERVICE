import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../interfaces/authenticated-user.interface';
import { userIdOf } from '../interfaces/authenticated-user.interface';
import { GatewaySignatureService } from '../security/gateway-signature.service';

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
}
