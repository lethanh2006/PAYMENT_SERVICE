import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  DataSource,
  EntityManager,
  LessThan,
  MoreThan,
  Not,
  type QueryResult,
} from 'typeorm';

import type { ReleaseReason } from '../../common/security/payment-request-context';
import { OutboxEventEntity } from '../../database/entities/outbox-event.entity';
import {
  PaymentEntity,
  PaymentStatus,
} from '../../database/entities/payment.entity';
import {
  WebhookProcessingStatus,
  WebhookReceiptEntity,
} from '../../database/entities/webhook-receipt.entity';
import { insertRefundCase } from './refund.repository';

export interface PayosTransactionInput {
  providerEventId: string;
  paymentCode: string;
  amount: number;
  providerReference: string | null;
  payloadHash: string;
  metadata: Record<string, unknown>;
  paidAt: Date;
  providerValidationError: string | null;
  requestId: string | null;
}

export interface WebhookProcessingResult {
  outcome: 'PROCESSED' | 'DUPLICATE' | 'REVIEW_REQUIRED';
  paymentId: string | null;
  reason?: string;
}

export interface CreateOrReuseResult {
  payment: PaymentEntity;
  /** Link PayOS cũ còn hạn vừa bị thay (đơn đổi số tiền hoặc chủ đơn), cần huỷ phía PayOS. */
  supersededLinkId: string | null;
}

/** Đơn đã huỷ hoặc đã thu tiền mặt: không cấp thêm link cho đơn này. */
export class OrderPaymentClosedError extends Error {
  constructor(readonly reason: ReleaseReason) {
    super(`Đơn hàng đã đóng thanh toán online (${reason})`);
  }
}

/** Trạng thái link phía PayOS mà đối soát còn phải hỏi lại; các trạng thái khác đã chốt. */
const OPEN_PROVIDER_STATUSES = ['PENDING', 'PROCESSING'];

@Injectable()
export class PaymentRepository {
  constructor(private readonly dataSource: DataSource) {}

  async createOrReuse(candidate: PaymentEntity): Promise<CreateOrReuseResult> {
    return this.dataSource.transaction(async (manager) => {
      // Mọi request tạo link cho cùng một đơn chạy lần lượt (bấm hai lần, hai tab, khách và thu ngân).
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        candidate.orderId,
      ]);
      const closure = await this.closureOf(manager, candidate.orderId);
      if (closure) {
        throw new OrderPaymentClosedError(closure);
      }

      const repository = manager.getRepository(PaymentEntity);
      // Khoá dòng PENDING trước khi đọc SUCCESS: webhook ghi SUCCESS cũng khoá dòng này, nên hai
      // bên chạy lần lượt. Đọc không khoá rồi ghi EXPIRED có thể đè lên SUCCESS webhook vừa commit.
      const pending = await repository
        .createQueryBuilder('payment')
        .setLock('pessimistic_write')
        .where('payment.order_id = :orderId', { orderId: candidate.orderId })
        .andWhere('payment.status = :status', {
          status: PaymentStatus.PENDING,
        })
        .orderBy('payment.created_at', 'DESC')
        .getOne();
      const successful = await repository.findOne({
        where: {
          orderId: candidate.orderId,
          status: PaymentStatus.SUCCESS,
        },
        order: { createdAt: 'DESC' },
      });
      if (successful) {
        return { payment: successful, supersededLinkId: null };
      }

      const stillOpen =
        pending !== null && pending.expiresAt.getTime() > Date.now();
      if (
        stillOpen &&
        pending.amount === candidate.amount &&
        pending.userId === candidate.userId
      ) {
        return { payment: pending, supersededLinkId: null };
      }
      if (pending) {
        pending.status = PaymentStatus.EXPIRED;
        await repository.save(pending);
      }

      return {
        payment: await repository.save(candidate),
        supersededLinkId: stillOpen ? pending.paymentLinkId : null,
      };
    });
  }

  /** Lý do đơn đã đóng thanh toán online, `null` nếu đơn còn nhận. */
  async findClosure(orderId: string): Promise<ReleaseReason | null> {
    return this.closureOf(this.dataSource.manager, orderId);
  }

  /**
   * Đóng thanh toán online của đơn và chốt CANCELLED mọi link PENDING, trả mã link PayOS cần huỷ.
   * Chạy dưới cùng advisory lock với `createOrReuse`, nên request tạo link song song hoặc xong trước
   * (link của nó bị huỷ ở đây) hoặc thấy dấu đóng và bị từ chối. Webhook tới sau gặp CANCELLED nên
   * chuyển đối soát hoàn tiền, không ghi SUCCESS.
   */
  async closeOrder(orderId: string, reason: ReleaseReason): Promise<string[]> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        orderId,
      ]);
      await manager.query(
        `INSERT INTO order_payment_closures (order_id, reason) VALUES ($1, $2)
         ON CONFLICT (order_id) DO NOTHING`,
        [orderId, reason],
      );
      const cancelled = await manager.query<
        [Array<{ payment_link_id: string | null }>, number]
      >(
        `UPDATE payments SET status = $2, updated_at = now()
         WHERE order_id = $1 AND status = $3
         RETURNING payment_link_id`,
        [orderId, PaymentStatus.CANCELLED, PaymentStatus.PENDING],
      );
      return cancelled[0]
        .map((row) => row.payment_link_id)
        .filter((linkId): linkId is string => Boolean(linkId));
    });
  }

  private async closureOf(
    manager: EntityManager,
    orderId: string,
  ): Promise<ReleaseReason | null> {
    const rows = await manager.query<Array<{ reason: ReleaseReason }>>(
      'SELECT reason FROM order_payment_closures WHERE order_id = $1',
      [orderId],
    );
    return rows[0]?.reason ?? null;
  }

  /**
   * Payment PayOS chưa chốt mà webhook có thể đã lỡ: tạo đủ lâu để webhook kịp về, chưa quá cửa sổ
   * đối soát, link phía PayOS chưa ở trạng thái cuối và lâu rồi chưa hỏi lại.
   */
  async findDueForReconciliation(input: {
    createdBefore: Date;
    createdAfter: Date;
    checkedBefore: Date;
    limit: number;
  }): Promise<PaymentEntity[]> {
    return this.dataSource
      .getRepository(PaymentEntity)
      .createQueryBuilder('payment')
      .where('payment.status IN (:...statuses)', {
        statuses: [PaymentStatus.PENDING, PaymentStatus.EXPIRED],
      })
      .andWhere('payment.payment_link_id IS NOT NULL')
      .andWhere('payment.created_at < :createdBefore', {
        createdBefore: input.createdBefore,
      })
      .andWhere('payment.created_at > :createdAfter', {
        createdAfter: input.createdAfter,
      })
      .andWhere(
        '(payment.provider_status IS NULL OR payment.provider_status IN (:...openStatuses))',
        { openStatuses: OPEN_PROVIDER_STATUSES },
      )
      .andWhere(
        '(payment.reconciled_at IS NULL OR payment.reconciled_at < :checkedBefore)',
        { checkedBefore: input.checkedBefore },
      )
      .orderBy('payment.reconciled_at', 'ASC', 'NULLS FIRST')
      .addOrderBy('payment.created_at', 'ASC')
      .limit(input.limit)
      .getMany();
  }

  /**
   * Ghi kết quả đối soát. Chỉ đụng payment còn PENDING/EXPIRED: nếu webhook vừa ghi SUCCESS song
   * song thì câu lệnh không làm gì, tránh đè trạng thái tiền đã về.
   */
  async recordProviderStatus(
    paymentId: string,
    providerStatus: string,
    finalStatus: PaymentStatus.CANCELLED | PaymentStatus.EXPIRED | null,
  ): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .update(PaymentEntity)
      .set({
        providerStatus,
        reconciledAt: () => 'now()',
        ...(finalStatus ? { status: finalStatus } : {}),
      })
      .where('id = :paymentId', { paymentId })
      .andWhere('status IN (:...statuses)', {
        statuses: [PaymentStatus.PENDING, PaymentStatus.EXPIRED],
      })
      .execute();
  }

  /** Payment đã trả, hoặc link còn hạn, để không tạo thêm link PayOS cho cùng một đơn. */
  async findActiveForOrder(orderId: string): Promise<PaymentEntity | null> {
    const payments = this.dataSource.getRepository(PaymentEntity);
    return (
      (await payments.findOne({
        where: { orderId, status: PaymentStatus.SUCCESS },
        order: { createdAt: 'DESC' },
      })) ??
      (await payments.findOne({
        where: {
          orderId,
          status: PaymentStatus.PENDING,
          expiresAt: MoreThan(new Date()),
        },
        order: { createdAt: 'DESC' },
      }))
    );
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

  async processPayosTransaction(
    input: PayosTransactionInput,
  ): Promise<WebhookProcessingResult> {
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
          VALUES ($1, 'PAYOS', $2, $3, NULL, 'RECEIVED')
          ON CONFLICT (provider, provider_event_id) DO NOTHING
          RETURNING id
        `,
        [receiptId, input.providerEventId, input.payloadHash],
        true,
      );
      const insertResult = rawInsertResult as QueryResult<{ id: string }>;

      if ((insertResult.affected ?? 0) === 0) {
        const existing = await manager
          .getRepository(WebhookReceiptEntity)
          .findOne({
            where: {
              provider: 'PAYOS',
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
        await openReviewRefundCase(
          manager,
          input,
          null,
          null,
          'Không tìm thấy mã thanh toán',
        );
        return {
          outcome: 'REVIEW_REQUIRED',
          paymentId: null,
          reason: 'Không tìm thấy mã thanh toán',
        };
      }

      const otherSuccess = await manager.getRepository(PaymentEntity).exists({
        where: {
          orderId: payment.orderId,
          status: PaymentStatus.SUCCESS,
          id: Not(payment.id),
        },
      });
      const validationError = otherSuccess
        ? 'Đơn hàng đã được thanh toán bằng một giao dịch khác'
        : validatePayosTransaction(payment, input);
      if (validationError) {
        await this.finishReceipt(
          manager,
          receiptId,
          WebhookProcessingStatus.REVIEW_REQUIRED,
          payment.id,
          validationError,
        );
        await openReviewRefundCase(
          manager,
          input,
          payment.id,
          payment.orderId,
          validationError,
        );
        return {
          outcome: 'REVIEW_REQUIRED',
          paymentId: payment.id,
          reason: validationError,
        };
      }

      const paidAt = input.paidAt;
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

/**
 * Tiền đã về nhưng không ghi nhận được (trả trùng, lệch tiền, link đã huỷ, mã lạ): mở hồ sơ hoàn tiền
 * cùng transaction với biên nhận. PayOS báo giao dịch thất bại thì không có tiền về nên bỏ qua.
 */
async function openReviewRefundCase(
  manager: EntityManager,
  input: PayosTransactionInput,
  paymentId: string | null,
  orderId: string | null,
  reason: string,
): Promise<void> {
  if (input.providerValidationError) {
    return;
  }
  await insertRefundCase(manager, {
    providerEventId: input.providerEventId,
    paymentId,
    orderId,
    amount: input.amount,
    reason,
    source: 'PAYMENT_REVIEW',
  });
}

/** Lỗi khiến giao dịch phải đối soát tay; `null` nếu được ghi nhận thành công. */
export function validatePayosTransaction(
  payment: PaymentEntity,
  input: PayosTransactionInput,
): string | null {
  if (input.providerValidationError) {
    return input.providerValidationError;
  }
  if (payment.status === PaymentStatus.SUCCESS) {
    return 'Thanh toán đã thành công bằng một giao dịch khác';
  }
  // PayOS tự khoá link theo expiredAt, nên tiền về sau khi worker đánh dấu EXPIRED vẫn
  // là tiền hợp lệ của link này và phải được ghi nhận.
  if (
    payment.status !== PaymentStatus.PENDING &&
    payment.status !== PaymentStatus.EXPIRED
  ) {
    return `Thanh toán đang ở trạng thái ${payment.status}`;
  }
  if (payment.amount !== input.amount) {
    return `Số tiền thực nhận ${input.amount} không khớp số tiền đơn hàng`;
  }
  return null;
}
