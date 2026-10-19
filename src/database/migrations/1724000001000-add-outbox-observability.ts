import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOutboxObservability1724000001000 implements MigrationInterface {
  name = 'AddOutboxObservability1724000001000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "outbox_events" ADD COLUMN "failed_at" timestamptz',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "outbox_events" DROP COLUMN "failed_at"',
    );
  }
}
