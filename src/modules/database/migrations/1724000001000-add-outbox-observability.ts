import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOutboxObservability1724000001000 implements MigrationInterface {
  name = 'AddOutboxObservability1724000001000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "outbox_events" ADD COLUMN "traceparent" varchar(512)',
    );
    await queryRunner.query(
      'ALTER TABLE "outbox_events" ADD COLUMN "tracestate" varchar(512)',
    );
    await queryRunner.query(
      'ALTER TABLE "outbox_events" ADD COLUMN "failed_at" timestamptz',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "outbox_events" DROP COLUMN "failed_at"',
    );
    await queryRunner.query(
      'ALTER TABLE "outbox_events" DROP COLUMN "tracestate"',
    );
    await queryRunner.query(
      'ALTER TABLE "outbox_events" DROP COLUMN "traceparent"',
    );
  }
}
