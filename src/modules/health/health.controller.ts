import { Controller, Get } from '@nestjs/common';
import {
  HealthService,
  type PaymentLivenessHealth,
  type PaymentReadinessHealth,
} from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get(['', 'live'])
  getLiveness(): PaymentLivenessHealth {
    return this.healthService.getLiveness();
  }

  @Get('ready')
  getReadiness(): Promise<PaymentReadinessHealth> {
    return this.healthService.getReadiness();
  }
}
