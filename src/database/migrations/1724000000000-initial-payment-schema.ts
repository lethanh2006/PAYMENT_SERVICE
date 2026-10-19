import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialPaymentSchema1724000000000 implements MigrationInterface {
  name = 'InitialPaymentSchema1724000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "payments" (
        "id" uuid NOT NULL,
        "order_id" varchar(64) NOT NULL,
        "user_id" varchar(64) NOT NULL,
        "payment_code" varchar(32) NOT NULL,
        "amount" bigint NOT NULL,
        "currency" char(3) NOT NULL DEFAULT 'VND',
        "status" varchar(24) NOT NULL DEFAULT 'PENDING',
        "payment_method" varchar(24) NOT NULL DEFAULT 'VIETQR',
        "provider" varchar(24) NOT NULL DEFAULT 'CASSO',
        "transfer_description" varchar(160) NOT NULL,
        "qr_url" text NOT NULL,
        "destination_account" varchar(64) NOT NULL,
        "provider_transaction_id" varchar(128),
        "provider_reference" varchar(160),
        "provider_metadata" jsonb,
        "review_reason" varchar(255),
        "expires_at" timestamptz NOT NULL,
        "paid_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_payments" PRIMARY KEY ("id"),
        CONSTRAINT "uq_payments_code" UNIQUE ("payment_code"),
        CONSTRAINT "ck_payments_amount_positive" CHECK ("amount" > 0),
        CONSTRAINT "ck_payments_currency" CHECK ("currency" = 'VND'),
        CONSTRAINT "ck_payments_status" CHECK (
          "status" IN ('PENDING', 'SUCCESS', 'FAILED', 'EXPIRED', 'REVIEW_REQUIRED', 'REFUNDED')
        ),
        CONSTRAINT "ck_payments_method" CHECK ("payment_method" = 'VIETQR'),
        CONSTRAINT "ck_payments_provider" CHECK ("provider" = 'CASSO')
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "idx_payments_order_created" ON "payments" ("order_id", "created_at" DESC)',
    );
    await queryRunner.query(
      'CREATE INDEX "idx_payments_user_created" ON "payments" ("user_id", "created_at" DESC)',
    );
    await queryRunner.query(
      'CREATE INDEX "idx_payments_status_expires" ON "payments" ("status", "expires_at")',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX "uq_payments_provider_transaction" ON "payments" ("provider_transaction_id") WHERE "provider_transaction_id" IS NOT NULL',
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payments_one_pending_order" ON "payments" ("order_id") WHERE "status" = 'PENDING'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payments_one_success_order" ON "payments" ("order_id") WHERE "status" = 'SUCCESS'`,
    );

    await queryRunner.query(`
      CREATE TABLE "webhook_receipts" (
        "id" uuid NOT NULL,
        "provider" varchar(24) NOT NULL,
        "provider_event_id" varchar(128) NOT NULL,
        "payment_id" uuid,
        "payload_hash" char(64) NOT NULL,
        "signature_timestamp" bigint,
        "status" varchar(32) NOT NULL,
        "failure_reason" varchar(255),
        "received_at" timestamptz NOT NULL DEFAULT now(),
        "processed_at" timestamptz,
        CONSTRAINT "pk_webhook_receipts" PRIMARY KEY ("id"),
        CONSTRAINT "uq_webhook_provider_event" UNIQUE ("provider", "provider_event_id"),
        CONSTRAINT "fk_webhook_payment" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL,
        CONSTRAINT "ck_webhook_status" CHECK (
          "status" IN ('RECEIVED', 'PROCESSED', 'DUPLICATE', 'REVIEW_REQUIRED', 'REJECTED')
        )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "outbox_events" (
        "id" uuid NOT NULL,
        "aggregate_id" uuid NOT NULL,
        "event_type" varchar(80) NOT NULL,
        "version" smallint NOT NULL DEFAULT 1,
        "payload" jsonb NOT NULL,
        "request_id" varchar(128),
        "attempt_count" integer NOT NULL DEFAULT 0,
        "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
        "last_error" varchar(500),
        "published_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_outbox_events" PRIMARY KEY ("id"),
        CONSTRAINT "fk_outbox_payment" FOREIGN KEY ("aggregate_id") REFERENCES "payments"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "idx_outbox_pending" ON "outbox_events" ("published_at", "next_attempt_at")',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "outbox_events"');
    await queryRunner.query('DROP TABLE IF EXISTS "webhook_receipts"');
    await queryRunner.query('DROP TABLE IF EXISTS "payments"');
  }
}
