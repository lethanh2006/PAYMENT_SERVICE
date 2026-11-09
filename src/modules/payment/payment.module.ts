import { Module } from '@nestjs/common';

import { PaymentExpiryWorker } from './payment-expiry.worker';
import { PaymentReconciliationWorker } from './payment-reconciliation.worker';
import { PaymentController } from './payment.controller';
import { PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';
import { PayosWebhookController } from './payos-webhook.controller';
import { PayosClient } from './payos.client';

@Module({
  controllers: [PaymentController, PayosWebhookController],
  providers: [
    PaymentService,
    PaymentRepository,
    PayosClient,
    PaymentExpiryWorker,
    PaymentReconciliationWorker,
  ],
})
export class PaymentModule {}
