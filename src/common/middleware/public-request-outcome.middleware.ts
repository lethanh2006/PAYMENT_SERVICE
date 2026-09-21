import { Injectable, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  classifyException,
  normalizeRouteTemplate,
} from '@nrapp/observability';
import type { NextFunction } from 'express';
import type { ResponseWithOutcome } from '../interfaces/http-outcome.interface';
import type { AuthenticatedRequest } from '../interfaces/request-context.interface';
import { appLogger } from '../logging/logger';

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
    request: AuthenticatedRequest,
    response: ResponseWithOutcome,
    next: NextFunction,
  ): void {
    if (this.enabled) {
      response.once('finish', () => this.recordRejection(request, response));
    }
    next();
  }

  private recordRejection(
    request: AuthenticatedRequest,
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
