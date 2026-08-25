import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { flushLoggerAndShutdownTelemetry } from '@nrapp/observability';
import { appLogger } from './app-logger';

@Injectable()
export class TelemetryLifecycleService implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await flushLoggerAndShutdownTelemetry(appLogger, 3_000);
  }
}
