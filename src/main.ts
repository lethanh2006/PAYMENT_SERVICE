import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { flushLogger, logException } from '@nrapp/observability';

import { AppModule } from './app.module';
import { appLogger, nestLogger } from './common/logging/logger';
import { createValidationException } from './common/pipes/validation-exception';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: nestLogger,
  });
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      exceptionFactory: createValidationException,
    }),
  );

  const port = Number(process.env.PORT) || 5006;
  await app.listen(port);
  appLogger.info(
    { 'event.name': 'service.started', 'server.port': port },
    'Payment service đã khởi động',
  );
}

void bootstrap().catch(async (error: unknown) => {
  logException(
    appLogger,
    'process.bootstrap.failed',
    error,
    {},
    {
      message: 'Không thể khởi động dịch vụ thanh toán',
      classification: {
        statusCode: 500,
        code: 'BOOTSTRAP_FAILED',
        expected: false,
        retryable: false,
        logLevel: 'fatal',
      },
    },
  );
  await flushLogger(appLogger);
  process.exitCode = 1;
});
