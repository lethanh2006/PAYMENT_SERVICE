import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

interface SignedGatewayHeaders {
  payload: string;
  requestId?: string;
  signature?: string;
  timestamp?: string;
}

@Injectable()
export class GatewaySignatureService implements OnModuleInit {
  private readonly logger = new Logger(GatewaySignatureService.name);
  private readonly secret: string | undefined;
  private readonly signatureRequired: boolean;
  private readonly maxAgeMs: number;

  constructor(configService: ConfigService) {
    this.secret = configService.get<string>('PAYMENT_INTERNAL_SECRET')?.trim();
    this.signatureRequired =
      configService.get<string>('PAYMENT_REQUIRE_SIGNATURE')?.toLowerCase() ===
        'true' || configService.get<string>('NODE_ENV') === 'production';
    const configuredMaxAge = Number(
      configService.get<string>('PAYMENT_SIGNATURE_MAX_AGE_MS') ?? 300_000,
    );
    this.maxAgeMs =
      Number.isSafeInteger(configuredMaxAge) && configuredMaxAge > 0
        ? configuredMaxAge
        : 300_000;
  }

  onModuleInit(): void {
    if (this.signatureRequired && (!this.secret || this.secret.length < 32)) {
      throw new Error(
        'PAYMENT_INTERNAL_SECRET phải có ít nhất 32 ký tự khi chữ ký Gateway là bắt buộc',
      );
    }
    if (!this.secret) {
      this.logger.warn(
        'Payment chưa bật chữ ký Gateway; chỉ dùng cấu hình này ở local development',
      );
    }
  }

  assertTrusted(headers: SignedGatewayHeaders): void {
    if (!this.secret && !this.signatureRequired) {
      return;
    }

    const { payload, requestId, signature, timestamp } = headers;
    if (!this.secret || !requestId || !signature || !timestamp) {
      throw new UnauthorizedException('Thông tin Gateway không hợp lệ');
    }

    const timestampNumber = Number(timestamp);
    if (
      !Number.isSafeInteger(timestampNumber) ||
      Math.abs(Date.now() - timestampNumber) > this.maxAgeMs
    ) {
      throw new UnauthorizedException('Thông tin Gateway đã hết hạn');
    }

    const expected = createHmac('sha256', this.secret)
      .update(`${timestamp}.${requestId}.${payload}`)
      .digest('hex');
    const supplied = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (
      supplied.length !== expectedBuffer.length ||
      !timingSafeEqual(supplied, expectedBuffer)
    ) {
      throw new UnauthorizedException('Chữ ký Gateway không hợp lệ');
    }
  }
}
