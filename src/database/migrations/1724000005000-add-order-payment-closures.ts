import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Đơn đã huỷ hoặc đã thu tiền mặt thì không còn nhận thanh toán online. Dấu "đã đóng" được ghi
 * dưới cùng advisory lock với việc tạo link, nên request tạo QR chạy song song với việc huỷ đơn
 * không thể để lại một link còn mở sau khi đơn đã đóng.
 */
export class AddOrderPaymentClosures1724000005000 implements MigrationInterface {
  name = 'AddOrderPaymentClosures1724000005000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "order_payment_closures" (
        "order_id" varchar(64) PRIMARY KEY,
        "reason" varchar(32) NOT NULL,
        "closed_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_order_payment_closures_reason" CHECK ("reason" IN ('ORDER_CANCELLED', 'PAID_IN_CASH'))
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "order_payment_closures"');
  }
}
