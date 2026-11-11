import { Module } from '@nestjs/common';

import { CanteenUnappliedConsumer } from './canteen-unapplied.consumer';
import { PaymentExpiryWorker } from './payment-expiry.worker';
import { PaymentReconciliationWorker } from './payment-reconciliation.worker';
import { PaymentController } from './payment.controller';
import { PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';
import { PayosWebhookController } from './payos-webhook.controller';
import { PayosClient } from './payos.client';
import { RefundController } from './refund.controller';
import { RefundRepository } from './refund.repository';
import { RefundService } from './refund.service';

@Module({
  controllers: [PaymentController, PayosWebhookController, RefundController],
  providers: [
    PaymentService,
    PaymentRepository,
    PayosClient,
    PaymentExpiryWorker,
    PaymentReconciliationWorker,
    RefundRepository,
    RefundService,
    CanteenUnappliedConsumer,
  ],
})
export class PaymentModule {}
