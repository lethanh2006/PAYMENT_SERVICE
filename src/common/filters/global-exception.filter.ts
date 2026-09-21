import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Injectable,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  classifyException,
  logException,
  normalizeRouteTemplate,
} from '@nrapp/observability';
import type { AuthenticatedRequest } from '../interfaces/request-context.interface';
import type { ResponseWithOutcome } from '../interfaces/http-outcome.interface';
import { appLogger } from '../logging/logger';

@Catch()
@Injectable()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<ResponseWithOutcome>();
    const classification = classifyException(exception);

    response.locals.observabilityOutcome = {
      errorCode: classification.code,
      validationFields: classification.validationFields,
    };

    let errorId: string | undefined;
    if (!classification.expected) {
      const result = logException(
        appLogger,
        'http.request.failed',
        exception,
        {
          'http.request.method': request.method,
          'http.route': routeTemplate(request),
          'http.response.status_code': classification.statusCode,
          request_id: request.requestId,
        },
        { classification },
      );
      errorId = result.errorId;
    }

    const body = classification.expected
      ? expectedResponse(classification, request.requestId)
      : {
          statusCode: classification.statusCode,
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          requestId: request.requestId,
          errorId,
        };

    this.httpAdapterHost.httpAdapter.reply(
      response,
      body,
      classification.statusCode,
    );
  }
}

function routeTemplate(request: AuthenticatedRequest): string {
  const route = (request.route as { path?: unknown } | undefined)?.path;
  const base = request.baseUrl ?? '';
  return normalizeRouteTemplate(
    typeof route === 'string' ? `${base}${route}` : 'unknown',
  );
}

function expectedResponse(
  classification: ReturnType<typeof classifyException>,
  requestId: string | undefined,
): Record<string, unknown> {
  return {
    statusCode: classification.statusCode,
    code: classification.code,
    message: classification.safeMessage,
    ...(classification.validationFields.length
      ? { details: { fields: classification.validationFields } }
      : {}),
    requestId,
  };
}
