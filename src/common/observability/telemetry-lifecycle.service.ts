import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { shutdownTelemetry } from '@nrapp/observability';
import { appLogger } from './app-logger';

@Injectable()
export class TelemetryLifecycleService implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    try {
      appLogger.flush();
    } finally {
      await shutdownTelemetry(3_000);
    }
  }
}
