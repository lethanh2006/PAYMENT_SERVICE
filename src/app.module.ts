import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { CoreModule } from './core/core.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './modules/health/health.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { PaymentModule } from './modules/payment/payment.module';
import { RabbitMQModule } from './modules/rabbitmq/rabbitmq.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../.env', '.env'] }),
    CoreModule,
    DatabaseModule,
    RabbitMQModule,
    HealthModule,
    PaymentModule,
    OutboxModule,
  ],
})
export class AppModule {}
