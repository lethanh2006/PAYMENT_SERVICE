import { BadRequestException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { appLogger } from '../observability/app-logger';
import { GlobalExceptionFilter } from './global-exception.filter';

describe('GlobalExceptionFilter payment observability', () => {
  const reply = jest.fn(
    (response: unknown, body: unknown, statusCode: number) => {
      void response;
      void body;
      void statusCode;
    },
  );
  const filter = new GlobalExceptionFilter({
    httpAdapter: { reply },
  } as unknown as HttpAdapterHost);

  afterEach(() => {
    jest.restoreAllMocks();
    reply.mockReset();
  });

  it('không ghi lại expected 4xx ở service downstream', () => {
    const errorSpy = jest.spyOn(appLogger, 'error').mockImplementation();
    const host = httpHost('req-400');

    filter.catch(new BadRequestException('Dữ liệu không hợp lệ'), host);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        statusCode: 400,
        code: 'BAD_REQUEST',
        requestId: 'req-400',
      }),
      400,
    );
  });

  it('ghi một origin error và chỉ trả errorId an toàn cho 5xx', () => {
    const errorSpy = jest.spyOn(appLogger, 'error').mockImplementation();
    const host = httpHost('req-500');

    filter.catch(
      Object.assign(new Error('postgres connection failed'), {
        code: 'ECONNREFUSED',
      }),
      host,
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const response = reply.mock.calls[0][1] as Record<string, unknown>;
    expect(response).toMatchObject({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: 'req-500',
    });
    expect(response.errorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(JSON.stringify(response)).not.toContain('postgres');
    expect(JSON.stringify(response)).not.toContain('ECONNREFUSED');
  });
});

function httpHost(requestId: string): ArgumentsHost {
  const response = { locals: {} };
  const request = {
    method: 'POST',
    baseUrl: '/api/payment',
    route: { path: '/create-qr' },
    requestId,
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}
