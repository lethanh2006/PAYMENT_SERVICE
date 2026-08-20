import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RabbitMQService } from './modules/rabbitmq/rabbitmq.service';

@Controller()
export class AppController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly rabbitMQService: RabbitMQService,
  ) {}

  @Get('health')
  getHealth() {
    return { status: 'ok', service: 'payment' };
  }

  @Get('health/ready')
  async getReadiness() {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException('PostgreSQL chưa sẵn sàng');
    }
    if (!this.rabbitMQService.isReady()) {
      throw new ServiceUnavailableException('RabbitMQ chưa sẵn sàng');
    }
    return {
      status: 'ready',
      service: 'payment',
      dependencies: { postgresql: 'up', rabbitmq: 'up' },
    };
  }
}
