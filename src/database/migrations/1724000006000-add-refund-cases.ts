import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hồ sơ hoàn tiền: mỗi lần tiền vào không gắn được vào đơn (trả trùng, lệch tiền, link đã huỷ, Canteen
 * từ chối vì đơn đã huỷ hoặc đã trả) thành đúng một hồ sơ, nhân viên chốt REFUNDED hoặc DISMISSED.
 */
export class AddRefundCases1724000006000 implements MigrationInterface {
  name = 'AddRefundCases1724000006000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "refund_cases" (
        "id" uuid PRIMARY KEY,
        "provider_event_id" varchar(128) NOT NULL,
        "payment_id" uuid,
        "order_id" varchar(64),
        "amount" bigint NOT NULL,
        "reason" varchar(255) NOT NULL,
        "source" varchar(24) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'OPEN',
        "resolved_by" varchar(64),
        "resolution_note" varchar(500),
        "resolved_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_refund_cases_event" UNIQUE ("provider_event_id"),
        CONSTRAINT "fk_refund_cases_payment" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL,
        CONSTRAINT "ck_refund_cases_amount" CHECK ("amount" > 0),
        CONSTRAINT "ck_refund_cases_source" CHECK ("source" IN ('PAYMENT_REVIEW', 'ORDER_UNAPPLIED')),
        CONSTRAINT "ck_refund_cases_status" CHECK ("status" IN ('OPEN', 'REFUNDED', 'DISMISSED')),
        CONSTRAINT "ck_refund_cases_resolution" CHECK (("status" = 'OPEN') = ("resolved_at" IS NULL))
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "idx_refund_cases_status_created" ON "refund_cases" ("status", "created_at" DESC)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "refund_cases"');
  }
}
