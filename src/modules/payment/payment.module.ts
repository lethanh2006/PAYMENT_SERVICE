import { Module } from '@nestjs/common';
import { CassoSignatureService } from './casso-signature.service';
import { CassoWebhookController } from './casso-webhook.controller';
import { PaymentController } from './payment.controller';
import { PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';
import { VietQrService } from './vietqr.service';
import { PaymentExpiryWorker } from './payment-expiry.worker';

@Module({
  controllers: [PaymentController, CassoWebhookController],
  providers: [
    PaymentService,
    PaymentRepository,
    CassoSignatureService,
    VietQrService,
    PaymentExpiryWorker,
  ],
})
export class PaymentModule {}
