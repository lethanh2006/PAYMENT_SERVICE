import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Casso có thể retry một delivery trong 24 giờ. Idempotency được đảm bảo bằng
// provider transaction ID trong PostgreSQL; freshness chỉ bật khi cấu hình rõ.
const DEFAULT_MAX_AGE_MS = 0;
const SHA512_HEX_LENGTH = 128;

interface ParsedCassoSignature {
  timestamp: string;
  timestampMs: number;
  signatures: Buffer[];
}

/**
 * Creates the canonical JSON value required by Casso Webhook V2.
 * Object keys are sorted at every depth; array order remains significant.
 */
export function sortCassoPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortCassoPayload(item));
  }

  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;

    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = sortCassoPayload(source[key]);
        return sorted;
      }, {});
  }

  return value;
}

@Injectable()
export class CassoSignatureService {
  private readonly secrets: readonly string[];
  private readonly configuredMaxAgeMs: number;

  constructor(private readonly configService: ConfigService) {
    const currentSecret =
      this.readConfig('CASSO_WEBHOOK_SECRET') ?? this.readConfig('WEBHOOK_KEY');
    const previousSecret = this.readConfig('CASSO_WEBHOOK_PREVIOUS_SECRET');
    if (!currentSecret) {
      throw new Error('Thiếu cấu hình CASSO_WEBHOOK_SECRET');
    }

    this.secrets = [...new Set([currentSecret, previousSecret].filter(isText))];
    this.configuredMaxAgeMs = this.readMaxAge();
  }

  /**
   * Verifies a Casso `t=...,v1=...` signature against the active secret and,
   * during key rotation, the previous secret. `maxAgeMs = 0` disables the
   * timestamp freshness check but the timestamp still has to be milliseconds.
   */
  verify(
    signatureHeader: string | undefined,
    payload: unknown,
    maxAgeMs: number = this.configuredMaxAgeMs,
  ): boolean {
    if (this.secrets.length === 0 || !this.isValidMaxAge(maxAgeMs)) {
      return false;
    }

    const parsed = this.parseHeader(signatureHeader);
    if (!parsed || !this.isFresh(parsed.timestampMs, maxAgeMs)) {
      return false;
    }

    let canonicalPayload: string;
    try {
      canonicalPayload = JSON.stringify(sortCassoPayload(payload));
    } catch {
      return false;
    }

    if (canonicalPayload === undefined) {
      return false;
    }

    const signedMessage = `${parsed.timestamp}.${canonicalPayload}`;
    let verified = false;

    // Always check every configured secret/signature pair. Besides supporting
    // rotation, this avoids exposing which secret matched through early return.
    for (const secret of this.secrets) {
      const expected = createHmac('sha512', secret)
        .update(signedMessage, 'utf8')
        .digest();

      for (const supplied of parsed.signatures) {
        verified = timingSafeEqual(expected, supplied) || verified;
      }
    }

    return verified;
  }

  private parseHeader(header: string | undefined): ParsedCassoSignature | null {
    if (!header) {
      return null;
    }

    let timestamp: string | undefined;
    const signatures: Buffer[] = [];

    for (const part of header.split(',')) {
      const separator = part.indexOf('=');
      if (separator < 1) {
        continue;
      }

      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (key === 't' && timestamp === undefined) {
        timestamp = value;
      } else if (
        key === 'v1' &&
        value.length === SHA512_HEX_LENGTH &&
        /^[0-9a-f]+$/i.test(value)
      ) {
        signatures.push(Buffer.from(value, 'hex'));
      }
    }

    if (!timestamp || signatures.length === 0 || !/^\d+$/.test(timestamp)) {
      return null;
    }

    const timestampMs = Number(timestamp);
    if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) {
      return null;
    }

    return { timestamp, timestampMs, signatures };
  }

  private isFresh(timestampMs: number, maxAgeMs: number): boolean {
    return maxAgeMs === 0 || Math.abs(Date.now() - timestampMs) <= maxAgeMs;
  }

  private isValidMaxAge(maxAgeMs: number): boolean {
    return (
      Number.isFinite(maxAgeMs) &&
      Number.isSafeInteger(maxAgeMs) &&
      maxAgeMs >= 0
    );
  }

  private readMaxAge(): number {
    const raw = this.configService.get<string | number>(
      'CASSO_SIGNATURE_MAX_AGE_MS',
    );
    if (raw === undefined || raw === null || raw === '') {
      return DEFAULT_MAX_AGE_MS;
    }

    const value = Number(raw);
    return this.isValidMaxAge(value) ? value : DEFAULT_MAX_AGE_MS;
  }

  private readConfig(key: string): string | undefined {
    const value = this.configService.get<string>(key)?.trim();
    return value || undefined;
  }
}

function isText(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}
