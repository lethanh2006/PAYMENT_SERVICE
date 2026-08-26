import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RabbitMQModule } from '../rabbitmq/rabbitmq.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [DatabaseModule, RabbitMQModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
