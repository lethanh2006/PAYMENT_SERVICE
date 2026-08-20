import { Module } from '@nestjs/common';
import { OutboxPublisher } from './outbox.publisher';

@Module({
  providers: [OutboxPublisher],
})
export class OutboxModule {}
