import { createHmac } from 'node:crypto';

import {
  payosDataString,
  signPayosData,
  signPayosPaymentRequest,
  verifyPayosData,
} from './payos-signature';

const KEY = 'checksum-key-for-tests';

describe('Chữ ký PayOS', () => {
  it('sắp khoá, đổi null thành rỗng và JSON hoá mảng như SDK PayOS', () => {
    expect(
      payosDataString({
        orderCode: 123,
        amount: 3000,
        counterAccountName: null,
        description: 'VQRIO123',
        items: [{ quantity: 1, name: 'Cơm' }],
        skipped: undefined,
      }),
    ).toBe(
      'amount=3000&counterAccountName=&description=VQRIO123&items=[{"name":"Cơm","quantity":1}]&orderCode=123',
    );
  });

  it('ký yêu cầu tạo link theo đúng năm trường PayOS quy định', () => {
    const fields = {
      orderCode: 17_620_000_012_345,
      amount: 45_000,
      description: 'NRP012345',
      returnUrl: 'https://app.example/return',
      cancelUrl: 'https://app.example/cancel',
    };
    expect(signPayosPaymentRequest(fields, KEY)).toBe(
      createHmac('sha256', KEY)
        .update(
          'amount=45000&cancelUrl=https://app.example/cancel&description=NRP012345&orderCode=17620000012345&returnUrl=https://app.example/return',
        )
        .digest('hex'),
    );
  });

  it('chỉ chấp nhận chữ ký khớp với đúng dữ liệu và khoá', () => {
    const data = { orderCode: 1, amount: 2000, reference: 'FT1' };
    const signature = signPayosData(data, KEY);

    expect(verifyPayosData(data, signature, KEY)).toBe(true);
    expect(verifyPayosData({ ...data, amount: 1 }, signature, KEY)).toBe(false);
    expect(verifyPayosData(data, signature, 'khoa-khac')).toBe(false);
    expect(verifyPayosData(data, 'abc', KEY)).toBe(false);
    expect(verifyPayosData(data, undefined, KEY)).toBe(false);
  });
});
