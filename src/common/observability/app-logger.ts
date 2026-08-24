import { createAppLogger, PinoNestLogger } from '@nrapp/observability';

export const appLogger: ReturnType<typeof createAppLogger> = createAppLogger({
  serviceName: 'payment',
});

export const nestLogger = new PinoNestLogger(appLogger, 'Payment');
