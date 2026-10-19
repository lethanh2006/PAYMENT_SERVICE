import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum PaymentStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
  REVIEW_REQUIRED = 'REVIEW_REQUIRED',
  REFUNDED = 'REFUNDED',
}

export enum PaymentMethod {
  VIETQR = 'VIETQR',
}

export enum PaymentProvider {
  CASSO = 'CASSO',
}

const bigintNumberTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

@Entity({ name: 'payments' })
@Index('idx_payments_order_created', ['orderId', 'createdAt'])
@Index('idx_payments_user_created', ['userId', 'createdAt'])
@Index('idx_payments_status_expires', ['status', 'expiresAt'])
export class PaymentEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'order_id', type: 'varchar', length: 64 })
  orderId: string;

  @Column({ name: 'user_id', type: 'varchar', length: 64 })
  userId: string;

  @Column({ name: 'payment_code', type: 'varchar', length: 32, unique: true })
  paymentCode: string;

  @Column({ type: 'bigint', transformer: bigintNumberTransformer })
  amount: number;

  @Column({ type: 'char', length: 3, default: 'VND' })
  currency: string;

  @Column({ type: 'varchar', length: 24, default: PaymentStatus.PENDING })
  status: PaymentStatus;

  @Column({
    name: 'payment_method',
    type: 'varchar',
    length: 24,
    default: PaymentMethod.VIETQR,
  })
  paymentMethod: PaymentMethod;

  @Column({ type: 'varchar', length: 24, default: PaymentProvider.CASSO })
  provider: PaymentProvider;

  @Column({ name: 'transfer_description', type: 'varchar', length: 160 })
  transferDescription: string;

  @Column({ name: 'qr_url', type: 'text' })
  qrUrl: string;

  @Column({ name: 'destination_account', type: 'varchar', length: 64 })
  destinationAccount: string;

  @Column({
    name: 'provider_transaction_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  providerTransactionId: string | null;

  @Column({
    name: 'provider_reference',
    type: 'varchar',
    length: 160,
    nullable: true,
  })
  providerReference: string | null;

  @Column({ name: 'provider_metadata', type: 'jsonb', nullable: true })
  providerMetadata: Record<string, unknown> | null;

  @Column({
    name: 'review_reason',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  reviewReason: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
