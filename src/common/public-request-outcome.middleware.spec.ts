import type { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { appLogger } from './observability';
import { PublicRequestOutcomeMiddleware } from './public-request-outcome.middleware';

describe('PublicRequestOutcomeMiddleware', () => {
  afterEach(() => jest.restoreAllMocks());

  it('mặc định tắt để không ghi trùng webhook đi qua Gateway', () => {
    const middleware = createMiddleware(undefined);
    const response = createResponse(422);
    const infoSpy = jest.spyOn(appLogger, 'info').mockImplementation();

    middleware.use(createRequest(), response, jest.fn());
    response.emit('finish');

    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('chỉ ghi một rejection event khi public entry được bật rõ ràng', () => {
    const middleware = createMiddleware('true');
    const response = createResponse(422);
    response.locals.observabilityOutcome = {
      errorCode: 'VALIDATION_ERROR',
      validationFields: ['amount'],
    };
    const infoSpy = jest.spyOn(appLogger, 'info').mockImplementation();

    middleware.use(createRequest(), response, jest.fn());
    response.emit('finish');

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toMatchObject({
      'event.name': 'http.request.rejected',
      'http.route': '/api/payment/webhooks/casso',
      'http.response.status_code': 422,
      'error.code': 'VALIDATION_ERROR',
      'validation.fields': ['amount'],
      request_id: 'req-public',
    });
  });
});

function createMiddleware(value: string | undefined) {
  const config = {
    get: jest.fn().mockReturnValue(value),
  } as unknown as ConfigService;
  return new PublicRequestOutcomeMiddleware(config);
}

function createRequest() {
  return {
    method: 'POST',
    path: '/api/payment/webhooks/casso',
    requestId: 'req-public',
  } as unknown as Request & { requestId?: string };
}

function createResponse(statusCode: number) {
  return Object.assign(new EventEmitter(), {
    statusCode,
    locals: {},
  }) as unknown as Response & {
    locals: {
      observabilityOutcome?: {
        errorCode: string;
        validationFields: string[];
      };
    };
  };
}
