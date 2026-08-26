import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RabbitMQService } from '../rabbitmq/rabbitmq.service';

export interface PaymentLivenessHealth {
  status: 'ok';
  service: 'payment';
}

export interface PaymentReadinessHealth {
  status: 'ready';
  service: 'payment';
  dependencies: {
    postgresql: 'up';
    rabbitmq: 'up';
  };
}

@Injectable()
export class HealthService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly rabbitMQService: RabbitMQService,
  ) {}

  getLiveness(): PaymentLivenessHealth {
    return { status: 'ok', service: 'payment' };
  }

  async getReadiness(): Promise<PaymentReadinessHealth> {
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
