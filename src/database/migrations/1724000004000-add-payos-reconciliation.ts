import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Đối soát chủ động với PayOS khi webhook không tới: lưu trạng thái link phía PayOS và lần
 * đối soát gần nhất, thêm trạng thái CANCELLED cho link khách đã huỷ trên trang PayOS.
 */
export class AddPayosReconciliation1724000004000 implements MigrationInterface {
  name = 'AddPayosReconciliation1724000004000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "payments" DROP CONSTRAINT "ck_payments_status"',
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_status" CHECK ("status" IN ('PENDING', 'SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED', 'REVIEW_REQUIRED', 'REFUNDED'))`,
    );
    await queryRunner.query(
      'ALTER TABLE "payments" ADD COLUMN "provider_status" varchar(24)',
    );
    await queryRunner.query(
      'ALTER TABLE "payments" ADD COLUMN "reconciled_at" timestamptz',
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payments_reconcile" ON "payments" ("created_at") WHERE "status" IN ('PENDING', 'EXPIRED')`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "idx_payments_reconcile"');
    await queryRunner.query(
      'ALTER TABLE "payments" DROP COLUMN "reconciled_at"',
    );
    await queryRunner.query(
      'ALTER TABLE "payments" DROP COLUMN "provider_status"',
    );
    await queryRunner.query(
      `UPDATE "payments" SET "status" = 'EXPIRED' WHERE "status" = 'CANCELLED'`,
    );
    await queryRunner.query(
      'ALTER TABLE "payments" DROP CONSTRAINT "ck_payments_status"',
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_status" CHECK ("status" IN ('PENDING', 'SUCCESS', 'FAILED', 'EXPIRED', 'REVIEW_REQUIRED', 'REFUNDED'))`,
    );
  }
}
