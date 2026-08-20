import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.listen(process.env.PORT ?? 5006);
}

bootstrap().catch((error: unknown) => {
  const typedError = error instanceof Error ? error : new Error(String(error));
  new Logger('Bootstrap').error(
    `Không thể khởi động Payment Service: ${typedError.message}`,
    typedError.stack,
  );
  process.exitCode = 1;
});
