import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import { paymentDatabaseOptions } from '../../database/database.options';
import { OutboxEventEntity } from '../../database/entities/outbox-event.entity';
import {
  PaymentEntity,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
} from '../../database/entities/payment.entity';
import {
  OrderPaymentClosedError,
  PaymentRepository,
  type PayosTransactionInput,
} from './payment.repository';

/**
 * Giao dịch đồng thời trên PostgreSQL thật: chỉ chạy khi đặt PAYMENT_TEST_DATABASE_URL tới một
 * server được phép tạo database (mỗi lần chạy tạo một database tạm rồi xoá). Không có biến này
 * thì bỏ qua, nên CI không cần PostgreSQL.
 *   PAYMENT_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npx jest payment.concurrency
 */
const serverUrl = process.env.PAYMENT_TEST_DATABASE_URL;
const describeWithDatabase = serverUrl ? describe : describe.skip;

let codeSequence = 0;

function candidate(orderId: string, amount = 45_000): PaymentEntity {
  codeSequence += 1;
  return Object.assign(new PaymentEntity(), {
    id: randomUUID(),
    orderId,
    userId: 'user-1',
    paymentCode: `${Date.now()}${codeSequence}`,
    amount,
    currency: 'VND',
    status: PaymentStatus.PENDING,
    paymentMethod: PaymentMethod.PAYOS,
    provider: PaymentProvider.PAYOS,
    transferDescription: `NRP${codeSequence}`,
    qrCode: '000201',
    checkoutUrl: 'https://pay.payos.vn/web/test',
    paymentLinkId: `link-${randomUUID()}`,
    destinationAccount: '0123456789',
    providerTransactionId: null,
    providerReference: null,
    providerMetadata: null,
    reviewReason: null,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    paidAt: null,
    providerStatus: null,
    reconciledAt: null,
  });
}

function transfer(
  payment: PaymentEntity,
  reference: string,
): PayosTransactionInput {
  return {
    providerEventId: `${payment.paymentLinkId}:${reference}`,
    paymentCode: payment.paymentCode,
    amount: payment.amount,
    providerReference: reference,
    payloadHash: createHash('sha256').update(reference).digest('hex'),
    metadata: {},
    paidAt: new Date(),
    providerValidationError: null,
    requestId: null,
  };
}

describeWithDatabase(
  'PaymentRepository: giao dịch đồng thời trên PostgreSQL thật',
  () => {
    const databaseName = `payment_test_${randomUUID().replaceAll('-', '')}`;
    let dataSource: DataSource;
    let payments: PaymentRepository;

    const outboxCount = (paymentId: string) =>
      dataSource
        .getRepository(OutboxEventEntity)
        .countBy({ aggregateId: paymentId });
    const statusOf = async (paymentId: string) =>
      (
        await dataSource
          .getRepository(PaymentEntity)
          .findOneByOrFail({ id: paymentId })
      ).status;

    beforeAll(async () => {
      const admin = new Client({ connectionString: serverUrl });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      await admin.end();

      const url = new URL(serverUrl as string);
      const savedEnvironment = { ...process.env };
      Object.assign(process.env, {
        PAYMENT_DB_USER: decodeURIComponent(url.username),
        PAYMENT_DB_PASSWORD: decodeURIComponent(url.password),
        PAYMENT_DB_NAME: databaseName,
      });
      const options = paymentDatabaseOptions() as PostgresConnectionOptions;
      process.env = savedEnvironment;

      dataSource = new DataSource({
        ...options,
        host: url.hostname,
        port: Number(url.port || 5432),
        migrationsRun: false,
        // Đủ kết nối để các transaction thật sự chạy song song thay vì xếp hàng chờ pool.
        extra: { max: 30 },
      });
      await dataSource.initialize();
      await dataSource.runMigrations();
      payments = new PaymentRepository(dataSource);
    });

    afterAll(async () => {
      await dataSource?.destroy();
      const admin = new Client({ connectionString: serverUrl });
      await admin.connect();
      await admin.query(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      );
      await admin.end();
    });

    it('10 request tạo link cùng lúc cho một đơn chỉ giữ lại một link', async () => {
      const orderId = `order-${randomUUID()}`;

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          payments.createOrReuse(candidate(orderId)),
        ),
      );

      expect(new Set(results.map(({ payment }) => payment.id)).size).toBe(1);
      await expect(
        dataSource.getRepository(PaymentEntity).countBy({ orderId }),
      ).resolves.toBe(1);
    });

    it('20 webhook trùng đến cùng lúc chỉ ghi nhận tiền và báo canteen một lần', async () => {
      const { payment } = await payments.createOrReuse(
        candidate(`order-${randomUUID()}`),
      );

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () =>
          payments.processPayosTransaction(transfer(payment, 'FT-DUP')),
        ),
      );

      const count = (outcome: string) =>
        outcomes.filter((result) => result.outcome === outcome).length;
      expect(count('PROCESSED')).toBe(1);
      expect(count('DUPLICATE')).toBe(19);
      await expect(outboxCount(payment.id)).resolves.toBe(1);
      await expect(statusOf(payment.id)).resolves.toBe(PaymentStatus.SUCCESS);
    });

    it('hai người cùng chuyển tiền vào một link: lần sau chờ đối soát để hoàn tiền', async () => {
      const { payment } = await payments.createOrReuse(
        candidate(`order-${randomUUID()}`),
      );

      const outcomes = await Promise.all([
        payments.processPayosTransaction(transfer(payment, 'FT-A')),
        payments.processPayosTransaction(transfer(payment, 'FT-B')),
      ]);

      expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual([
        'PROCESSED',
        'REVIEW_REQUIRED',
      ]);
      await expect(outboxCount(payment.id)).resolves.toBe(1);
      await expect(statusOf(payment.id)).resolves.toBe(PaymentStatus.SUCCESS);
    });

    it('cấp link mới đúng lúc tiền về không đè trạng thái SUCCESS (lost update)', async () => {
      for (let round = 0; round < 25; round += 1) {
        const orderId = `order-${randomUUID()}`;
        const { payment } = await payments.createOrReuse(
          candidate(orderId, 45_000),
        );

        // Đơn đổi số tiền nên request thứ hai phải thay link, đúng lúc webhook báo link cũ đã trả.
        const [webhook] = await Promise.all([
          payments.processPayosTransaction(transfer(payment, `FT-${round}`)),
          payments.createOrReuse(candidate(orderId, 50_000)),
        ]);

        expect(webhook.outcome).toBe('PROCESSED');
        await expect(statusOf(payment.id)).resolves.toBe(PaymentStatus.SUCCESS);
        await expect(outboxCount(payment.id)).resolves.toBe(1);
      }
    });

    it('đối soát chốt CANCELLED song song với tiền về: không bao giờ vừa huỷ vừa báo đã trả', async () => {
      for (let round = 0; round < 25; round += 1) {
        const { payment } = await payments.createOrReuse(
          candidate(`order-${randomUUID()}`),
        );

        await Promise.all([
          payments.processPayosTransaction(transfer(payment, `FT-C${round}`)),
          payments.recordProviderStatus(
            payment.id,
            'CANCELLED',
            PaymentStatus.CANCELLED,
          ),
        ]);

        const status = await statusOf(payment.id);
        const events = await outboxCount(payment.id);
        // Tiền về trước: SUCCESS và đúng 1 sự kiện. Huỷ trước: webhook gặp CANCELLED, chờ đối soát, 0 sự kiện.
        expect([
          [PaymentStatus.SUCCESS, 1],
          [PaymentStatus.CANCELLED, 0],
        ]).toContainEqual([status, events]);
      }
    });

    it('huỷ đơn song song với tạo link: không bao giờ còn link mở cho đơn đã đóng', async () => {
      let refused = 0;
      for (let round = 0; round < 25; round += 1) {
        const orderId = `order-${randomUUID()}`;

        const [created] = await Promise.allSettled([
          payments.createOrReuse(candidate(orderId)),
          payments.closeOrder(orderId, 'ORDER_CANCELLED'),
        ]);

        if (created.status === 'rejected') {
          expect(created.reason).toBeInstanceOf(OrderPaymentClosedError);
          refused += 1;
        }
        await expect(
          dataSource
            .getRepository(PaymentEntity)
            .countBy({ orderId, status: PaymentStatus.PENDING }),
        ).resolves.toBe(0);
        // Sau khi đã đóng, mọi lần tạo link tiếp theo đều bị từ chối.
        await expect(
          payments.createOrReuse(candidate(orderId)),
        ).rejects.toBeInstanceOf(OrderPaymentClosedError);
      }
      // Ghi lại để thấy cả hai thứ tự đều đã xảy ra trong 25 vòng.
      console.info(
        `tạo link bị từ chối ${refused}/25 vòng, bị huỷ sau khi tạo ${25 - refused}/25 vòng`,
      );
    });

    it('huỷ đơn đúng lúc tiền về: hoặc đã trả và báo canteen, hoặc đã đóng và chờ hoàn tiền', async () => {
      for (let round = 0; round < 25; round += 1) {
        const orderId = `order-${randomUUID()}`;
        const { payment } = await payments.createOrReuse(candidate(orderId));

        const [webhook] = await Promise.all([
          payments.processPayosTransaction(transfer(payment, `FT-X${round}`)),
          payments.closeOrder(orderId, 'ORDER_CANCELLED'),
        ]);

        const status = await statusOf(payment.id);
        const events = await outboxCount(payment.id);
        expect([
          [PaymentStatus.SUCCESS, 1, 'PROCESSED'],
          [PaymentStatus.CANCELLED, 0, 'REVIEW_REQUIRED'],
        ]).toContainEqual([status, events, webhook.outcome]);
      }
    });
  },
);
