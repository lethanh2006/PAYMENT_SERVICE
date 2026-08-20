import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../interfaces/authenticated-user.interface';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction,
  ): void {
    const supplied = request.header('x-request-id');
    const requestId =
      supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();

    request.requestId = requestId;
    response.setHeader('x-request-id', requestId);
    next();
  }
}
