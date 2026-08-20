import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GatewayAuthGuard } from '../common/guards/gateway-auth.guard';
import { RequestIdMiddleware } from '../common/middleware/request-id.middleware';
import { GatewaySignatureService } from '../common/security/gateway-signature.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [GatewaySignatureService, GatewayAuthGuard],
  exports: [GatewaySignatureService, GatewayAuthGuard],
})
export class CoreModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
