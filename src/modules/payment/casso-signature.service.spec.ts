import type { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import {
  CassoSignatureService,
  sortCassoPayload,
} from './casso-signature.service';

const CURRENT_SECRET = 'casso-current-secret';
const PREVIOUS_SECRET = 'casso-previous-secret';

function config(values: Record<string, string>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function signature(
  secret: string,
  timestamp: string,
  payload: unknown,
): string {
  const canonical = JSON.stringify(sortCassoPayload(payload));
  return createHmac('sha512', secret)
    .update(`${timestamp}.${canonical}`)
    .digest('hex');
}

function service(
  overrides: Record<string, string> = {},
): CassoSignatureService {
  return new CassoSignatureService(
    config({
      CASSO_WEBHOOK_SECRET: CURRENT_SECRET,
      CASSO_WEBHOOK_PREVIOUS_SECRET: PREVIOUS_SECRET,
      CASSO_SIGNATURE_MAX_AGE_MS: '300000',
      ...overrides,
    }),
  );
}

describe('CassoSignatureService', () => {
  const payload = {
    error: 0,
    data: {
      reference: 'BANK-1',
      amount: 50_000,
      metadata: [
        { z: 1, a: 2 },
        { b: true, a: null },
      ],
    },
  };

  it('sorts nested objects without changing array order', () => {
    expect(sortCassoPayload({ z: 1, a: [{ z: 2, a: 1 }, { c: 3 }] })).toEqual({
      a: [{ a: 1, z: 2 }, { c: 3 }],
      z: 1,
    });
  });

  it('accepts a valid Webhook V2 signature made with the current secret', () => {
    const timestamp = Date.now().toString();
    const header = `t=${timestamp},v1=${signature(CURRENT_SECRET, timestamp, payload)}`;

    expect(service().verify(header, payload)).toBe(true);
  });

  it('accepts the previous secret during secret rotation', () => {
    const timestamp = Date.now().toString();
    const header = `t=${timestamp},v1=${signature(PREVIOUS_SECRET, timestamp, payload)}`;

    expect(service().verify(header, payload)).toBe(true);
  });

  it('rejects malformed and invalid signatures', () => {
    expect(service().verify('invalid', payload)).toBe(false);
    expect(
      service().verify(`t=${Date.now()},v1=${'g'.repeat(128)}`, payload),
    ).toBe(false);
    expect(
      service().verify(`t=${Date.now()},v1=${'0'.repeat(128)}`, payload),
    ).toBe(false);
  });

  it('rejects a timestamp outside the configured tolerance', () => {
    const timestamp = (Date.now() - 300_001).toString();
    const header = `t=${timestamp},v1=${signature(CURRENT_SECRET, timestamp, payload)}`;

    expect(service().verify(header, payload)).toBe(false);
  });

  it('can disable only the freshness check with maxAgeMs zero', () => {
    const timestamp = '1700000000000';
    const header = `t=${timestamp},v1=${signature(CURRENT_SECRET, timestamp, payload)}`;

    expect(service().verify(header, payload, 0)).toBe(true);
  });

  it('uses WEBHOOK_KEY as a backwards-compatible current secret', () => {
    const timestamp = Date.now().toString();
    const header = `t=${timestamp},v1=${signature(CURRENT_SECRET, timestamp, payload)}`;
    const verifier = new CassoSignatureService(
      config({
        WEBHOOK_KEY: CURRENT_SECRET,
        CASSO_SIGNATURE_MAX_AGE_MS: '300000',
      }),
    );

    expect(verifier.verify(header, payload)).toBe(true);
  });

  it('fails closed when no webhook secret is configured', () => {
    const timestamp = Date.now().toString();
    const header = `t=${timestamp},v1=${signature(CURRENT_SECRET, timestamp, payload)}`;

    expect(new CassoSignatureService(config({})).verify(header, payload)).toBe(
      false,
    );
  });
});
