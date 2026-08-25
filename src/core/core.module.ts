import {
  Global,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter';
import { PublicRequestOutcomeMiddleware } from '../common/middleware/public-request-outcome.middleware';
import { GatewayAuthGuard } from '../common/guards/gateway-auth.guard';
import {
  PublicRequestIdMiddleware,
  RequestIdMiddleware,
} from '../common/middleware/request-id.middleware';
import { TelemetryLifecycleService } from '../common/observability/telemetry-lifecycle.service';
import { GatewaySignatureService } from '../common/security/gateway-signature.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    GatewaySignatureService,
    GatewayAuthGuard,
    PublicRequestOutcomeMiddleware,
    TelemetryLifecycleService,
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
  exports: [GatewaySignatureService, GatewayAuthGuard],
})
export class CoreModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    const publicRoutes = [
      { path: 'webhook/casso', method: RequestMethod.POST },
      { path: 'api/payment/webhooks/casso', method: RequestMethod.POST },
      { path: 'api/payment/callback', method: RequestMethod.POST },
    ];

    consumer
      .apply(PublicRequestIdMiddleware, PublicRequestOutcomeMiddleware)
      .forRoutes(...publicRoutes);
    consumer
      .apply(RequestIdMiddleware)
      .exclude(...publicRoutes)
      .forRoutes('*');
  }
}
