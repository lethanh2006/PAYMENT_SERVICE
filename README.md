# Payment Service

Payment Service tạo VietQR cho đơn hàng Canteen, nhận Casso Webhook V2 và lưu
toàn bộ trạng thái thanh toán trong PostgreSQL. Service không dùng MongoDB hoặc
Redis.

Xem [PAYMENT_SERVICE_GUIDE.md](./PAYMENT_SERVICE_GUIDE.md) để đọc tài liệu đầy
đủ về kiến trúc, code, cấu hình, triển khai, kiểm thử và xử lý sự cố.

## Luồng chính

1. Gateway xác thực JWT và lấy `finalAmount` trực tiếp từ Canteen.
2. Gateway gọi `POST /api/payment/create-qr` bằng identity nội bộ có HMAC.
3. Payment tạo/reuse một intent `PENDING` và trả URL VietQR.
4. Casso gọi `POST /api/payment/webhooks/casso` (hoặc `/webhook/casso`).
5. Payment xác thực HMAC-SHA512, khóa intent, kiểm tra account/amount và xử lý
   idempotent theo `data.id`.
6. Cập nhật `SUCCESS` và ghi outbox trong cùng transaction PostgreSQL.
7. Outbox phát `payment.succeeded.v1` tới queue
   `canteen.payment.succeeded.v1`; Canteen cập nhật `paymentStatus=PAID`.

Outbox mặc định retry vô hạn với exponential backoff khi RabbitMQ gián đoạn.
Chỉ đặt `PAYMENT_OUTBOX_MAX_ATTEMPTS` thành số dương nếu đã có quy trình cảnh
báo và re-drive các row có `failed_at`.

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
trước khi kết nối Casso thật.

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
