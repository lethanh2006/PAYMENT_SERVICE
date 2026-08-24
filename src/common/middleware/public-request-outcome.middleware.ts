import { Injectable, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  classifyException,
  normalizeRouteTemplate,
  recordHttpRejection,
} from '@nrapp/observability';
import type { NextFunction, Request, Response } from 'express';
import type { HttpOutcomeContext } from '../filters/global-exception.filter';
import { appLogger } from '../observability/app-logger';

interface RequestWithCorrelation extends Request {
  requestId?: string;
}

interface ResponseWithOutcome extends Response {
  locals: Response['locals'] & {
    observabilityOutcome?: HttpOutcomeContext;
  };
}

@Injectable()
export class PublicRequestOutcomeMiddleware implements NestMiddleware {
  private readonly enabled: boolean;

  constructor(configService: ConfigService) {
    this.enabled =
      configService
        .get<string>('PAYMENT_PUBLIC_ENTRY_LOG_REJECTIONS')
        ?.trim()
        .toLowerCase() === 'true';
  }

  use(
    request: RequestWithCorrelation,
    response: ResponseWithOutcome,
    next: NextFunction,
  ): void {
    if (this.enabled) {
      response.once('finish', () => this.recordRejection(request, response));
    }
    next();
  }

  private recordRejection(
    request: RequestWithCorrelation,
    response: ResponseWithOutcome,
  ): void {
    if (response.statusCode < 400 || response.statusCode >= 500) {
      return;
    }

    const outcome = response.locals.observabilityOutcome;
    const classification = classifyException(undefined, {
      statusCode: response.statusCode,
      code: outcome?.errorCode,
      expected: true,
    });
    const route = publicRouteTemplate(request.path);
    const fields = {
      'event.name': 'http.request.rejected',
      'http.request.method': request.method,
      'http.route': route,
      'http.response.status_code': response.statusCode,
      'error.code': classification.code,
      ...(outcome?.validationFields.length
        ? { 'validation.fields': outcome.validationFields }
        : {}),
      request_id: request.requestId,
    };

    const level = classification.logLevel === 'warn' ? 'warn' : 'info';
    appLogger[level](fields, 'Public payment request rejected');
    recordHttpRejection({
      method: request.method,
      route,
      statusCode: response.statusCode,
      errorCode: classification.code,
    });
  }
}

function publicRouteTemplate(path: string): string {
  if (path.endsWith('/webhooks/casso')) {
    return '/api/payment/webhooks/casso';
  }
  if (path.endsWith('/callback')) {
    return '/api/payment/callback';
  }
  return normalizeRouteTemplate('/webhook/casso');
}
