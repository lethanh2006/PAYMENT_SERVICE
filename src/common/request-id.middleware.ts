import { Injectable, type NestMiddleware } from '@nestjs/common';
import {
  CLIENT_REQUEST_ID_HEADER,
  REQUEST_ID_HEADER,
  createRequestCorrelation,
  isSafeRequestId,
  runWithLogContext,
} from '@nrapp/observability';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from './auth';

export {
  CLIENT_REQUEST_ID_HEADER,
  REQUEST_ID_HEADER,
  SAFE_REQUEST_ID,
} from '@nrapp/observability';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction,
  ): void {
    applyRequestCorrelation(request, response, next, true);
  }
}

@Injectable()
export class PublicRequestIdMiddleware implements NestMiddleware {
  use(
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction,
  ): void {
    applyRequestCorrelation(request, response, next, false);
  }
}

function applyRequestCorrelation(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction,
  trustIncoming: boolean,
): void {
  const correlation = createRequestCorrelation(
    request.headers[REQUEST_ID_HEADER],
    { trustIncoming },
  );
  const forwardedClientRequestId = request.headers[CLIENT_REQUEST_ID_HEADER];
  const clientRequestId = trustIncoming
    ? isSafeRequestId(forwardedClientRequestId)
      ? forwardedClientRequestId
      : undefined
    : correlation.clientRequestId;

  request.requestId = correlation.requestId;
  request.clientRequestId = clientRequestId;
  request.headers[REQUEST_ID_HEADER] = correlation.requestId;
  if (clientRequestId) {
    request.headers[CLIENT_REQUEST_ID_HEADER] = clientRequestId;
  } else {
    delete request.headers[CLIENT_REQUEST_ID_HEADER];
  }
  response.setHeader(REQUEST_ID_HEADER, correlation.requestId);
  runWithLogContext(
    {
      request_id: correlation.requestId,
      ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
    },
    () => next(),
  );
}
