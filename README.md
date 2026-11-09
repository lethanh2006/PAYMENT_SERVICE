# Payment Service

Payment Service tạo link và mã QR PayOS cho đơn hàng Canteen, nhận webhook PayOS và
lưu toàn bộ trạng thái thanh toán trong PostgreSQL. Service không dùng MongoDB hoặc
Redis.

Xem [COMMON.md](COMMON.md) để đọc luồng request, cấu trúc code dùng chung và
trạng thái Payment trong cấu hình VPS.

## Kho dữ liệu

PostgreSQL (TypeORM) vì dữ liệu là tiền và đối soát: cần ACID, ràng buộc unique cho
idempotency webhook và outbox phát sự kiện an toàn bằng `FOR UPDATE SKIP LOCKED`. Service
nối với Canteen bằng sự kiện, không dùng chung database.

Đánh giá đầy đủ và các quyết định đang chờ: [docs/DATA_STORES.md](../docs/DATA_STORES.md).

## Luồng chính

1. Client gọi Gateway `POST /api/payment/orders/:orderId/payos`. Gateway đọc đơn từ
   Canteen bằng quyền của người gọi và lấy `finalAmount`; client không gửi số tiền.
2. Gateway gọi `POST /api/payment/create-qr`, HMAC ký kèm đơn, chủ đơn và số tiền.
3. Payment dùng lại link còn hạn của đơn, hoặc gọi PayOS tạo link mới (`orderCode` là số
   nguyên duy nhất, lưu ở cột `payment_code`) và trả `checkoutUrl`, `qrCode` (chuỗi
   VietQR để client tự vẽ QR), `expiresAt`.
4. PayOS gọi webhook công khai của Gateway `POST /api/payment/webhooks/payos`, Gateway
   chuyển nguyên body tới Payment.
5. Payment xác thực HMAC-SHA256 bằng `PAYOS_CHECKSUM_KEY`, khóa payment theo `orderCode`,
   kiểm tra số tiền và xử lý idempotent theo `paymentLinkId:reference`. Tiền về cho link
   đã `EXPIRED` vẫn được ghi nhận vì PayOS tự khoá link theo `expiredAt`.
6. Cập nhật `SUCCESS` và ghi outbox trong cùng transaction PostgreSQL.
7. Outbox phát `payment.succeeded.v1` tới queue `canteen.payment.succeeded.v1`; Canteen
   đặt đơn `PAID`, `COMPLETED`, `paymentMethod=PAYOS` và giải phóng bàn. Đơn đã hủy, đã
   trả trước đó hoặc lệch tiền không bị sửa: Canteen ghi log `canteen.payment.unapplied`
   để nhân viên hoàn tiền thủ công.

Webhook sai chữ ký nhận 400; webhook đúng chữ ký luôn nhận 200, kể cả khi cần đối soát,
để PayOS không gửi lại. Khi đăng ký webhook trên PayOS, PayOS gửi một giao dịch thử với
`orderCode` không tồn tại; giao dịch này được lưu `REVIEW_REQUIRED` và vẫn nhận 200.

Outbox mặc định retry vô hạn với exponential backoff khi RabbitMQ gián đoạn.
Chỉ đặt `PAYMENT_OUTBOX_MAX_ATTEMPTS` thành số dương nếu đã có quy trình cảnh
báo và re-drive các row có `failed_at`.

Webhook có thể không tới (server tắt lúc PayOS gọi, mạng lỗi). Worker đối soát hỏi PayOS mỗi
`PAYMENT_RECONCILE_INTERVAL_MS` (mặc định 60 giây) trạng thái các link chưa chốt trong 24 giờ, ghi
nhận tiền bị lỡ qua đúng đường idempotent của webhook, và chốt `CANCELLED` cho link khách đã huỷ
trên trang PayOS.

Mọi tình huống tranh chấp (hai người cùng trả, webhook trùng, cấp link mới đúng lúc tiền về...) và
mọi kiểu lỗi, cơ chế xử lý, công nghệ dùng và test chứng minh: [PAYMENT.md](PAYMENT.md).

## Chạy local

Từ thư mục `backend`:

```bash
docker compose up -d --wait payment-postgres rabbitmq
cd payment
npm ci
npm run migration:run
npm run start:dev
```

Sao chép `.env.example` thành `.env` và thay toàn bộ secret/thông tin tài khoản
trước khi kết nối PayOS thật. Webhook cần URL HTTPS công khai; khi dev local, mở
tunnel (cloudflared, ngrok) tới Gateway cổng 3000 rồi đăng ký
`https://<tunnel>/api/payment/webhooks/payos` trong trang quản lý PayOS.

Khi chạy toàn bộ backend bằng Compose, cấu hình tài khoản PostgreSQL và
`PAYMENT_INTERNAL_SECRET` nằm trong `backend/.env`; Compose tự nối Payment tới
host nội bộ `payment-postgres:5432`. PostgreSQL chỉ được publish ra
`127.0.0.1:5433` theo mặc định để phục vụ phát triển local.

## Kiểm tra

```bash
npm run build
npm test -- --runInBand
npm run lint
```

`GET /health` là liveness; `GET /health/ready` kiểm tra PostgreSQL và RabbitMQ.

Test tranh chấp trên PostgreSQL thật (bỏ qua nếu không đặt biến; xem PAYMENT.md mục 8):

```bash
docker run -d --rm --name payment-test-pg -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine
PAYMENT_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npx jest payment.concurrency
docker rm -f payment-test-pg
```
