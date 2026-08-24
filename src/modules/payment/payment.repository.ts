import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, LessThan, type QueryResult } from 'typeorm';
import { OutboxEventEntity } from '../database/entities/outbox-event.entity';
import {
  PaymentEntity,
  PaymentStatus,
} from '../database/entities/payment.entity';
import {
  WebhookProcessingStatus,
  WebhookReceiptEntity,
} from '../database/entities/webhook-receipt.entity';

export interface CassoTransactionInput {
  providerEventId: string;
  paymentCode: string;
  amount: number;
  destinationAccount: string;
  providerReference: string | null;
  payloadHash: string;
  signatureTimestamp: string | null;
  metadata: Record<string, unknown>;
  paidAt: Date | null;
  providerValidationError: string | null;
  requestId: string | null;
  traceparent: string | null;
  tracestate: string | null;
}

export interface CassoProcessingResult {
  outcome: 'PROCESSED' | 'DUPLICATE' | 'REVIEW_REQUIRED';
  paymentId: string | null;
  reason?: string;
}

@Injectable()
export class PaymentRepository {
  constructor(private readonly dataSource: DataSource) {}

  async createOrReuse(candidate: PaymentEntity): Promise<PaymentEntity> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        candidate.orderId,
      ]);

      const repository = manager.getRepository(PaymentEntity);
      const successful = await repository.findOne({
        where: {
          orderId: candidate.orderId,
          status: PaymentStatus.SUCCESS,
        },
        order: { createdAt: 'DESC' },
      });
      if (successful) {
        return successful;
      }

      const pending = await repository.findOne({
        where: {
          orderId: candidate.orderId,
          status: PaymentStatus.PENDING,
        },
        order: { createdAt: 'DESC' },
      });
      if (
        pending &&
        pending.expiresAt.getTime() > Date.now() &&
        pending.amount === candidate.amount &&
        pending.userId === candidate.userId
      ) {
        return pending;
      }
      if (pending) {
        pending.status = PaymentStatus.EXPIRED;
        await repository.save(pending);
      }

      return repository.save(candidate);
    });
  }

  async findById(id: string): Promise<PaymentEntity | null> {
    return this.dataSource.getRepository(PaymentEntity).findOneBy({ id });
  }

  async findLatestByOrder(orderId: string): Promise<PaymentEntity | null> {
    return this.dataSource.getRepository(PaymentEntity).findOne({
      where: { orderId },
      order: { createdAt: 'DESC' },
    });
  }

  async findHistory(userId: string, limit: number): Promise<PaymentEntity[]> {
    return this.dataSource.getRepository(PaymentEntity).find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async expirePendingPayments(): Promise<number> {
    const result = await this.dataSource.getRepository(PaymentEntity).update(
      {
        status: PaymentStatus.PENDING,
        expiresAt: LessThan(new Date()),
      },
      { status: PaymentStatus.EXPIRED },
    );
    return result.affected ?? 0;
  }

  async processCassoTransaction(
    input: CassoTransactionInput,
  ): Promise<CassoProcessingResult> {
    return this.dataSource.transaction(async (manager) => {
      const receiptId = randomUUID();
      const queryRunner = manager.queryRunner;
      if (!queryRunner) {
        throw new Error('Transaction PostgreSQL không có QueryRunner');
      }
      const rawInsertResult: unknown = await queryRunner.query(
        `
          INSERT INTO webhook_receipts (
            id, provider, provider_event_id, payload_hash,
            signature_timestamp, status
          )
          VALUES ($1, 'CASSO', $2, $3, $4, 'RECEIVED')
          ON CONFLICT (provider, provider_event_id) DO NOTHING
          RETURNING id
        `,
        [
          receiptId,
          input.providerEventId,
          input.payloadHash,
          input.signatureTimestamp,
        ],
        true,
      );
      const insertResult = rawInsertResult as QueryResult<{ id: string }>;

      if ((insertResult.affected ?? 0) === 0) {
        const existing = await manager
          .getRepository(WebhookReceiptEntity)
          .findOne({
            where: {
              provider: 'CASSO',
              providerEventId: input.providerEventId,
            },
          });
        const payloadChanged = existing?.payloadHash !== input.payloadHash;
        return {
          outcome: 'DUPLICATE',
          paymentId: existing?.paymentId ?? null,
          ...(payloadChanged
            ? { reason: 'Cùng mã giao dịch nhưng payload không trùng khớp' }
            : {}),
        };
      }

      const payment = await manager
        .getRepository(PaymentEntity)
        .createQueryBuilder('payment')
        .setLock('pessimistic_write')
        .where('payment.payment_code = :paymentCode', {
          paymentCode: input.paymentCode,
        })
        .getOne();

      if (!payment) {
        await this.finishReceipt(
          manager,
          receiptId,
          WebhookProcessingStatus.REVIEW_REQUIRED,
          null,
          'Không tìm thấy mã thanh toán',
        );
        return {
          outcome: 'REVIEW_REQUIRED',
          paymentId: null,
          reason: 'Không tìm thấy mã thanh toán',
        };
      }

      const validationError = validateCassoTransaction(payment, input);
      if (validationError) {
        await this.finishReceipt(
          manager,
          receiptId,
          WebhookProcessingStatus.REVIEW_REQUIRED,
          payment.id,
          validationError,
        );
        return {
          outcome: 'REVIEW_REQUIRED',
          paymentId: payment.id,
          reason: validationError,
        };
      }

      const paidAt = input.paidAt;
      if (!paidAt) {
        throw new Error('Thiếu thời gian giao dịch sau bước kiểm tra provider');
      }

      payment.status = PaymentStatus.SUCCESS;
      payment.providerTransactionId = input.providerEventId;
      payment.providerReference = input.providerReference;
      payment.providerMetadata = input.metadata;
      payment.reviewReason = null;
      payment.paidAt = paidAt;
      await manager.save(payment);

      const eventId = randomUUID();
      const occurredAt = new Date();
      const outbox = manager.create(OutboxEventEntity, {
        id: eventId,
        aggregateId: payment.id,
        eventType: 'payment.succeeded.v1',
        version: 1,
        requestId: input.requestId,
        traceparent: input.traceparent,
        tracestate: input.tracestate,
        attemptCount: 0,
        nextAttemptAt: occurredAt,
        lastError: null,
        publishedAt: null,
        failedAt: null,
        payload: {
          eventId,
          eventType: 'payment.succeeded.v1',
          version: 1,
          occurredAt: occurredAt.toISOString(),
          data: {
            paymentId: payment.id,
            orderId: payment.orderId,
            userId: payment.userId,
            amount: payment.amount,
            currency: payment.currency,
            paymentMethod: payment.paymentMethod,
            providerTransactionId: input.providerEventId,
            paidAt: paidAt.toISOString(),
          },
        },
      });
      await manager.save(outbox);
      await this.finishReceipt(
        manager,
        receiptId,
        WebhookProcessingStatus.PROCESSED,
        payment.id,
        null,
      );

      return { outcome: 'PROCESSED', paymentId: payment.id };
    });
  }

  private async finishReceipt(
    manager: EntityManager,
    receiptId: string,
    status: WebhookProcessingStatus,
    paymentId: string | null,
    failureReason: string | null,
  ): Promise<void> {
    await manager.getRepository(WebhookReceiptEntity).update(receiptId, {
      status,
      paymentId,
      failureReason,
      processedAt: new Date(),
    });
  }
}

export function validateCassoTransaction(
  payment: PaymentEntity,
  input: CassoTransactionInput,
): string | null {
  if (input.providerValidationError) {
    return input.providerValidationError;
  }
  if (payment.status === PaymentStatus.SUCCESS) {
    return 'Thanh toán đã thành công bằng một giao dịch khác';
  }
  if (payment.status !== PaymentStatus.PENDING) {
    return `Thanh toán đang ở trạng thái ${payment.status}`;
  }
  if (payment.expiresAt.getTime() <= Date.now()) {
    return 'Thanh toán đã hết hạn';
  }
  if (payment.amount !== input.amount) {
    return `Số tiền thực nhận ${input.amount} không khớp số tiền đơn hàng`;
  }
  if (
    normalizeAccount(payment.destinationAccount) !==
    normalizeAccount(input.destinationAccount)
  ) {
    return 'Giao dịch không thuộc tài khoản nhận tiền đã cấu hình';
  }
  return null;
}

function normalizeAccount(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}
