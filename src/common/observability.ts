import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import {
  createAppLogger,
  flushLoggerAndShutdownTelemetry,
  PinoNestLogger,
} from '@nrapp/observability';

export const appLogger: ReturnType<typeof createAppLogger> = createAppLogger({
  serviceName: 'payment',
});

export const nestLogger = new PinoNestLogger(appLogger, 'Payment');

@Injectable()
export class TelemetryLifecycleService implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await flushLoggerAndShutdownTelemetry(appLogger, 3_000);
  }
}
