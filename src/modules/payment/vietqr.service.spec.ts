import type { ConfigService } from '@nestjs/config';
import { VietQrService } from './vietqr.service';

function config(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    VIETQR_BANK_ID: 'OCB',
    VIETQR_ACCOUNT_NUMBER: '00123456789',
    VIETQR_ACCOUNT_NAME: 'Nguyen Van A',
    VIETQR_TEMPLATES: 'compact, print',
    VIETQR_DESCRIPTION_PREFIX: 'HDG STUDIO',
    ...overrides,
  };

  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('VietQrService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('builds an encoded VietQR URL from configuration', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const url = new URL(
      new VietQrService(config()).buildQrUrl({
        amount: 50_000,
        reference: 'pay/01?source=game & note=đủ',
      }),
    );

    expect(url.origin).toBe('https://img.vietqr.io');
    expect(url.pathname).toBe('/image/OCB-00123456789-compact.jpg');
    expect(url.searchParams.get('amount')).toBe('50000');
    expect(url.searchParams.get('addInfo')).toBe(
      'HDG STUDIO pay/01?source=game & note=đủ',
    );
    expect(url.searchParams.get('accountName')).toBe('Nguyen Van A');
  });

  it('selects from the configured template list', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.99);
    const url = new VietQrService(config()).buildQrUrl({
      amount: 1,
      reference: 'PAY-1',
    });

    expect(new URL(url).pathname).toBe('/image/OCB-00123456789-print.jpg');
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid amount %s',
    (amount) => {
      const vietQr = new VietQrService(config());
      expect(() => vietQr.buildQrUrl({ amount, reference: 'PAY-1' })).toThrow(
        RangeError,
      );
    },
  );

  it('rejects an empty payment reference', () => {
    const vietQr = new VietQrService(config());
    expect(() => vietQr.buildQrUrl({ amount: 10_000, reference: '' })).toThrow(
      TypeError,
    );
  });

  it('fails fast when required bank configuration is missing', () => {
    expect(
      () => new VietQrService(config({ VIETQR_ACCOUNT_NUMBER: '' })),
    ).toThrow('Thiếu cấu hình VIETQR_ACCOUNT_NUMBER');
  });
});
