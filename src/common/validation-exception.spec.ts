import type { ValidationError } from 'class-validator';
import { createValidationException } from './global-exception.filter';

describe('createValidationException', () => {
  it('chỉ trả tên field và không đưa giá trị đầu vào vào response', () => {
    const errors = [
      {
        property: 'credentials',
        children: [
          {
            property: 'password',
            value: 'secret-value',
            constraints: { minLength: 'password is too short' },
          },
        ],
      },
    ] as ValidationError[];

    const response = createValidationException(errors).getResponse();

    expect(response).toEqual({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      message: 'Dữ liệu không hợp lệ',
      details: { fields: ['credentials.password'] },
    });
    expect(JSON.stringify(response)).not.toContain('secret-value');
  });
});
