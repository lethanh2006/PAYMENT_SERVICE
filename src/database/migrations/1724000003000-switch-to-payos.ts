import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SwitchToPayos1724000003000 implements MigrationInterface {
  name = 'SwitchToPayos1724000003000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "payments" RENAME COLUMN "qr_url" TO "qr_code"',
    );
    await queryRunner.query(
      'ALTER TABLE "payments" ADD COLUMN "checkout_url" text',
    );
    await queryRunner.query(
      'ALTER TABLE "payments" ADD COLUMN "payment_link_id" varchar(64)',
    );
    // Dòng Casso/VietQR cũ vẫn hợp lệ để lịch sử đối soát không bị chặn khi migrate.
    await queryRunner.query(
      'ALTER TABLE "payments" DROP CONSTRAINT "ck_payments_method"',
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_method" CHECK ("payment_method" IN ('VIETQR', 'PAYOS'))`,
    );
    await queryRunner.query(
      'ALTER TABLE "payments" DROP CONSTRAINT "ck_payments_provider"',
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_provider" CHECK ("provider" IN ('CASSO', 'PAYOS'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "payment_method" SET DEFAULT 'PAYOS'`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "provider" SET DEFAULT 'PAYOS'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "payments" WHERE "provider" = 'PAYOS'`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "provider" SET DEFAULT 'CASSO'`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "payment_method" SET DEFAULT 'VIETQR'`,
    );
    await queryRunner.query(
      'ALTER TABLE "payments" DROP CONSTRAINT "ck_payments_provider"',
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_provider" CHECK ("provider" = 'CASSO')`,
    );
    await queryRunner.query(
      'ALTER TABLE "payments" DROP CONSTRAINT "ck_payments_method"',
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "ck_payments_method" CHECK ("payment_method" = 'VIETQR')`,
    );
    await queryRunner.query(
      'ALTER TABLE "payments" DROP COLUMN "payment_link_id"',
    );
    await queryRunner.query(
      'ALTER TABLE "payments" DROP COLUMN "checkout_url"',
    );
    await queryRunner.query(
      'ALTER TABLE "payments" RENAME COLUMN "qr_code" TO "qr_url"',
    );
  }
}
