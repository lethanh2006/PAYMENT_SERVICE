import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import type { DataSourceOptions } from 'typeorm';
import { OutboxEventEntity } from './entities/outbox-event.entity';
import { PaymentEntity } from './entities/payment.entity';
import { WebhookReceiptEntity } from './entities/webhook-receipt.entity';
import { InitialPaymentSchema1724000000000 } from './migrations/1724000000000-initial-payment-schema';

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Giá trị cấu hình số nguyên dương không hợp lệ: ${value}`);
  }
  return parsed;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Thiếu biến môi trường ${name} của Payment Service`);
  }
  return value;
}

export function paymentDatabaseOptions(): TypeOrmModuleOptions &
  DataSourceOptions {
  const sslEnabled = process.env.PAYMENT_DB_SSL?.toLowerCase() === 'true';

  return {
    type: 'postgres',
    host: process.env.PAYMENT_DB_HOST?.trim() || '127.0.0.1',
    port: positiveInteger(process.env.PAYMENT_DB_PORT, 5432),
    username: requiredEnvironment('PAYMENT_DB_USER'),
    password: requiredEnvironment('PAYMENT_DB_PASSWORD'),
    database: requiredEnvironment('PAYMENT_DB_NAME'),
    entities: [PaymentEntity, WebhookReceiptEntity, OutboxEventEntity],
    migrations: [InitialPaymentSchema1724000000000],
    migrationsRun:
      process.env.PAYMENT_DB_RUN_MIGRATIONS?.toLowerCase() !== 'false',
    migrationsTableName: 'payment_migrations',
    migrationsTransactionMode: 'all',
    synchronize: false,
    retryAttempts: 10,
    retryDelay: 3000,
    ssl: sslEnabled ? { rejectUnauthorized: false } : false,
  };
}
