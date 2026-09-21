import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { flushLogger, logException } from '@nrapp/observability';
import { AppModule } from './app.module';
import { createValidationException } from './common/utils/validation.util';
import { appLogger, nestLogger } from './common/logging/logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: nestLogger,
  });
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: createValidationException,
    }),
  );
  await app.listen(process.env.PORT ?? 5006);
}

void bootstrap().catch(async (error: unknown) => {
  logException(
    appLogger,
    'process.bootstrap.failed',
    error,
    {},
    {
      message: 'Không thể khởi động Payment Service',
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
