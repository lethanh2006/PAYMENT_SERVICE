import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { PaymentStatus } from '../../database/entities/payment.entity';

export type RefundSource = 'PAYMENT_REVIEW' | 'ORDER_UNAPPLIED';
export type RefundStatus = 'OPEN' | 'REFUNDED' | 'DISMISSED';
export type RefundOutcome = Exclude<RefundStatus, 'OPEN'>;

export interface RefundCase {
  id: string;
  providerEventId: string;
  paymentId: string | null;
  orderId: string | null;
  amount: number;
  reason: string;
  source: RefundSource;
  status: RefundStatus;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

interface RefundCaseRow {
  id: string;
  provider_event_id: string;
  payment_id: string | null;
  order_id: string | null;
  amount: string;
  reason: string;
  source: RefundSource;
  status: RefundStatus;
  resolved_by: string | null;
  resolution_note: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

export interface NewRefundCase {
  providerEventId: string;
  paymentId: string | null;
  orderId: string | null;
  amount: number;
  reason: string;
  source: RefundSource;
}

export type UnappliedOutcome =
  'OPENED' | 'DUPLICATE' | 'NOT_SUCCESS' | 'UNKNOWN_PAYMENT';

export type ResolveResult =
  | { outcome: 'RESOLVED'; refundCase: RefundCase }
  | { outcome: 'ALREADY_RESOLVED'; refundCase: RefundCase }
  | { outcome: 'NOT_FOUND' };

/**
 * Mở hồ sơ trong transaction của bên gọi; giao dịch đã có hồ sơ thì bỏ qua, nên gọi lại (webhook
 * trùng, Canteen gửi lại) không sinh hồ sơ thứ hai. Trả `true` nếu vừa mở hồ sơ mới.
 */
export async function insertRefundCase(
  manager: EntityManager,
  refundCase: NewRefundCase,
): Promise<boolean> {
  const rows = await manager.query<Array<{ id: string }>>(
    `INSERT INTO refund_cases (id, provider_event_id, payment_id, order_id, amount, reason, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (provider_event_id) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      refundCase.providerEventId,
      refundCase.paymentId,
      refundCase.orderId,
      refundCase.amount,
      refundCase.reason.slice(0, 255),
      refundCase.source,
    ],
  );
  return rows.length > 0;
}

/** Hàng hồ sơ hoàn tiền: mở từ sự kiện Canteen, liệt kê và chốt cho nhân viên. */
@Injectable()
export class RefundRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Canteen không áp được tiền của một payment SUCCESS vào đơn (đơn đã huỷ, đã trả, lệch tiền): mở
   * hồ sơ theo mã giao dịch của payment đó. Khoá dòng payment để không chạy đè việc chốt hoàn tiền.
   */
  async openForUnappliedPayment(
    paymentId: string,
    reason: string,
  ): Promise<UnappliedOutcome> {
    return this.dataSource.transaction(async (manager) => {
      const payments = await manager.query<
        Array<{
          id: string;
          order_id: string;
          amount: string;
          status: PaymentStatus;
          provider_transaction_id: string | null;
        }>
      >(
        `SELECT id, order_id, amount, status, provider_transaction_id
         FROM payments WHERE id = $1 FOR UPDATE`,
        [paymentId],
      );
      const payment = payments[0];
      if (!payment) {
        return 'UNKNOWN_PAYMENT';
      }
      if (payment.status !== PaymentStatus.SUCCESS) {
        // Đã REFUNDED (hồ sơ đã chốt) hoặc trạng thái lạ: không mở thêm hồ sơ.
        return 'NOT_SUCCESS';
      }
      const opened = await insertRefundCase(manager, {
        providerEventId:
          payment.provider_transaction_id ?? `payment:${payment.id}`,
        paymentId: payment.id,
        orderId: payment.order_id,
        amount: Number(payment.amount),
        reason,
        source: 'ORDER_UNAPPLIED',
      });
      return opened ? 'OPENED' : 'DUPLICATE';
    });
  }

  async list(
    status: RefundStatus | undefined,
    limit: number,
  ): Promise<RefundCase[]> {
    const rows = await this.dataSource.query<RefundCaseRow[]>(
      `SELECT * FROM refund_cases
       WHERE ($1::varchar IS NULL OR status = $1)
       ORDER BY created_at DESC
       LIMIT $2`,
      [status ?? null, limit],
    );
    return rows.map(toRefundCase);
  }

  /**
   * Chốt hồ sơ đúng một lần: câu lệnh chỉ đổi dòng còn OPEN, nên hai nhân viên bấm cùng lúc thì
   * một người thành công, người kia nhận ALREADY_RESOLVED. Hoàn tiền cho khoản Canteen từ chối thì
   * payment chuyển REFUNDED trong cùng transaction.
   */
  async resolve(
    caseId: string,
    outcome: RefundOutcome,
    resolvedBy: string,
    note: string | null,
  ): Promise<ResolveResult> {
    return this.dataSource.transaction(async (manager) => {
      const [updated] = await manager.query<[RefundCaseRow[], number]>(
        `UPDATE refund_cases
         SET status = $2, resolved_by = $3, resolution_note = $4,
             resolved_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'OPEN'
         RETURNING *`,
        [caseId, outcome, resolvedBy, note],
      );
      const row = updated[0];
      if (!row) {
        const existing = await manager.query<RefundCaseRow[]>(
          'SELECT * FROM refund_cases WHERE id = $1',
          [caseId],
        );
        return existing[0]
          ? {
              outcome: 'ALREADY_RESOLVED',
              refundCase: toRefundCase(existing[0]),
            }
          : { outcome: 'NOT_FOUND' };
      }
      if (
        outcome === 'REFUNDED' &&
        row.source === 'ORDER_UNAPPLIED' &&
        row.payment_id
      ) {
        await manager.query(
          `UPDATE payments SET status = $2, updated_at = now()
           WHERE id = $1 AND status = $3`,
          [row.payment_id, PaymentStatus.REFUNDED, PaymentStatus.SUCCESS],
        );
      }
      return { outcome: 'RESOLVED', refundCase: toRefundCase(row) };
    });
  }
}

function toRefundCase(row: RefundCaseRow): RefundCase {
  return {
    id: row.id,
    providerEventId: row.provider_event_id,
    paymentId: row.payment_id,
    orderId: row.order_id,
    amount: Number(row.amount),
    reason: row.reason,
    source: row.source,
    status: row.status,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}
