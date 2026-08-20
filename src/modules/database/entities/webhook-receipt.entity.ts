import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export enum WebhookProcessingStatus {
  RECEIVED = 'RECEIVED',
  PROCESSED = 'PROCESSED',
  DUPLICATE = 'DUPLICATE',
  REVIEW_REQUIRED = 'REVIEW_REQUIRED',
  REJECTED = 'REJECTED',
}

@Entity({ name: 'webhook_receipts' })
export class WebhookReceiptEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 24 })
  provider: string;

  @Column({ name: 'provider_event_id', type: 'varchar', length: 128 })
  providerEventId: string;

  @Column({ name: 'payment_id', type: 'uuid', nullable: true })
  paymentId: string | null;

  @Column({ name: 'payload_hash', type: 'char', length: 64 })
  payloadHash: string;

  @Column({ name: 'signature_timestamp', type: 'bigint', nullable: true })
  signatureTimestamp: string | null;

  @Column({ type: 'varchar', length: 32 })
  status: WebhookProcessingStatus;

  @Column({
    name: 'failure_reason',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  failureReason: string | null;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;
}
