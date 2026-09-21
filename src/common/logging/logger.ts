import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import {
  createAppLogger,
  flushLogger,
  PinoNestLogger,
} from '@nrapp/observability';

export const appLogger: ReturnType<typeof createAppLogger> = createAppLogger({
  serviceName: 'payment',
});

export const nestLogger = new PinoNestLogger(appLogger, 'Payment');

@Injectable()
export class LoggerLifecycleService implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await flushLogger(appLogger);
  }
}
