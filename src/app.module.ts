import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { DatabaseModule } from './modules/database/database.module';
import { RabbitMQModule } from './modules/rabbitmq/rabbitmq.module';
import { PaymentModule } from './modules/payment/payment.module';
import { CoreModule } from './core/core.module';
import { OutboxModule } from './modules/outbox/outbox.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../.env', '.env'],
    }),
    CoreModule,
    DatabaseModule,
    RabbitMQModule,
    PaymentModule,
    OutboxModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
