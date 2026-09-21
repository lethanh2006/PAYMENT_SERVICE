import {
  CLIENT_REQUEST_ID_HEADER,
  getLogContext,
  REQUEST_ID_HEADER,
  SAFE_REQUEST_ID,
} from '@nrapp/observability';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../interfaces/request-context.interface';
import {
  PublicRequestIdMiddleware,
  RequestIdMiddleware,
} from './request-id.middleware';

describe('Payment request correlation contract', () => {
  it('giữ canonical request ID từ Gateway đã tin cậy', () => {
    const result = runMiddleware(new RequestIdMiddleware(), {
      [REQUEST_ID_HEADER]: 'gateway-request-123',
      [CLIENT_REQUEST_ID_HEADER]: 'browser-request-123',
    });

    expect(result.request.requestId).toBe('gateway-request-123');
    expect(result.request.clientRequestId).toBe('browser-request-123');
    expect(result.context).toMatchObject({
      request_id: 'gateway-request-123',
      client_request_id: 'browser-request-123',
    });
  });

  it('tạo canonical request ID mới cho webhook và giữ ID an toàn của caller', () => {
    const result = runMiddleware(new PublicRequestIdMiddleware(), {
      [REQUEST_ID_HEADER]: 'casso-request-123',
      [CLIENT_REQUEST_ID_HEADER]: 'khong-duoc-tin-cay',
    });

    expect(result.request.requestId).toMatch(SAFE_REQUEST_ID);
    expect(result.request.requestId).not.toBe('casso-request-123');
    expect(result.request.clientRequestId).toBe('casso-request-123');
    expect(result.request.headers[REQUEST_ID_HEADER]).toBe(
      result.request.requestId,
    );
    expect(result.request.headers[CLIENT_REQUEST_ID_HEADER]).toBe(
      'casso-request-123',
    );
    expect(result.context).toMatchObject({
      request_id: result.request.requestId,
      client_request_id: 'casso-request-123',
    });
  });

  it('không giữ request ID public sai định dạng', () => {
    const result = runMiddleware(new PublicRequestIdMiddleware(), {
      [REQUEST_ID_HEADER]: '../../unsafe request-id',
      [CLIENT_REQUEST_ID_HEADER]: 'caller-controlled',
    });

    expect(result.request.requestId).toMatch(SAFE_REQUEST_ID);
    expect(result.request.clientRequestId).toBeUndefined();
    expect(result.request.headers[CLIENT_REQUEST_ID_HEADER]).toBeUndefined();
    expect(result.context).not.toHaveProperty('client_request_id');
  });
});

function runMiddleware(
  middleware: RequestIdMiddleware | PublicRequestIdMiddleware,
  headers: Record<string, string>,
) {
  const request = {
    headers: { ...headers },
  } as unknown as AuthenticatedRequest;
  const setHeader = jest.fn();
  const response = { setHeader } as unknown as Response;
  let context: Record<string, unknown> = {};
  const next = jest.fn(() => {
    context = getLogContext();
  }) as NextFunction;

  middleware.use(request, response, next);

  expect(next).toHaveBeenCalledTimes(1);
  expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, request.requestId);
  return { context, request, setHeader };
}
