import { Injectable, OnModuleInit } from '@nestjs/common';

import { RabbitMQService } from '../rabbitmq/rabbitmq.service';
import { RefundService } from './refund.service';

/** Tên queue do Canteen gửi tới (service nhận + loại sự kiện); đổi một bên là mất hồ sơ hoàn tiền. */
export const CANTEEN_UNAPPLIED_QUEUE = 'payment.canteen.payment.unapplied.v1';

@Injectable()
export class CanteenUnappliedConsumer implements OnModuleInit {
  constructor(
    private readonly rabbitMQService: RabbitMQService,
    private readonly refundService: RefundService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.rabbitMQService.subscribe(CANTEEN_UNAPPLIED_QUEUE, (message) =>
      this.refundService.recordUnapplied(message),
    );
  }
}
