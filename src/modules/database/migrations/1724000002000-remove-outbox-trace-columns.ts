import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveOutboxTraceColumns1724000002000 implements MigrationInterface {
  name = 'RemoveOutboxTraceColumns1724000002000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "outbox_events" DROP COLUMN IF EXISTS "tracestate"',
    );
    await queryRunner.query(
      'ALTER TABLE "outbox_events" DROP COLUMN IF EXISTS "traceparent"',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "outbox_events" ADD COLUMN IF NOT EXISTS "traceparent" varchar(512)',
    );
    await queryRunner.query(
      'ALTER TABLE "outbox_events" ADD COLUMN IF NOT EXISTS "tracestate" varchar(512)',
    );
  }
}
