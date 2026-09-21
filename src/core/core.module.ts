import {
  Global,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { GatewayAuthGuard } from '../common/gateway-auth.guard';
import { GatewaySignatureService } from '../common/gateway-signature.service';
import { GlobalExceptionFilter } from '../common/global-exception.filter';
import { TelemetryLifecycleService } from '../common/observability';
import { PublicRequestOutcomeMiddleware } from '../common/public-request-outcome.middleware';
import {
  PublicRequestIdMiddleware,
  RequestIdMiddleware,
} from '../common/request-id.middleware';

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
