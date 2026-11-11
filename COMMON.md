# Common của Payment

Điểm bắt đầu là `src/main.ts`, sau đó đến `src/core/core.module.ts` để xem
cách đăng ký middleware, guard, logger và exception filter.

Request từ Gateway: `RequestIdMiddleware` → `GatewayAuthGuard` → validation →
controller → `PaymentService` → repository PostgreSQL. Guard kiểm tra chữ ký
và gắn `request.user`; `create-qr` ký cả thông tin đơn hàng và số tiền.

Webhook công khai: `PublicRequestIdMiddleware` → `PublicRequestOutcomeMiddleware`
→ controller → service kiểm tra chữ ký PayOS. Nhánh này tạo request ID mới,
không tin request ID của caller như nhánh Gateway. Middleware ghi rejection chỉ
khi bật `PAYMENT_PUBLIC_ENTRY_LOG_REJECTIONS=true`.

| Thư mục trong `src/common` | Trách nhiệm |
| --- | --- |
| `middleware` | Request ID cho hai nhánh trên và log rejection của public entry. |
| `guards` | Đọc, xác thực identity Gateway và gắn user vào request. |
| `security` | Kiểm tra HMAC Gateway và tạo nội dung ký cho `create-qr`. |
| `interfaces` | Kiểu user, request và thông tin lỗi HTTP dùng chung. |
| `filters` | Chuyển exception thành response HTTP, ghi log lỗi ngoài dự kiến. |
| `logging` | Khởi tạo logger Payment, adapter Nest và flush khi dừng service. |
| `utils` | Lấy user ID và tạo lỗi validation 422 với tên field an toàn. |

Nghiệp vụ PayOS (client API, chữ ký checksum), worker hết hạn và worker đối soát
với PayOS nằm trong `modules/payment`. Webhook và đối soát cùng ghi tiền qua
`PaymentService.recordPayosTransaction`; khóa, idempotency và điều kiện bảo vệ nằm
trong `PaymentRepository`. Route `orders/:orderId/release-links` (Gateway gọi sau khi
Canteen huỷ đơn hoặc thu tiền mặt) được tin nhờ chữ ký gắn mã đơn và lý do, không kiểm
quyền theo người gọi. Giải thích đầy đủ: [PAYMENT.md](PAYMENT.md).
Transaction và migrations nằm trong `database`; phát sự kiện thanh toán
nằm trong `modules/outbox` và `modules/rabbitmq`. Payment cũng **nhận** message:
`CanteenUnappliedConsumer` đọc queue `payment.canteen.payment.unapplied.v1` (Canteen báo tiền
không áp được vào đơn) và mở hồ sơ hoàn tiền qua `RefundService`; `RefundController`
(`/api/payment/refunds`) cho nhân viên xem và chốt. `RabbitMQService` chỉ ack sau khi xử lý
xong, lỗi tạm chép sang `<queue>.retry`, message hỏng sang `<queue>.dead`.

Gateway mở các route `/api/payment/*` và chuyển webhook PayOS tới đây. Trong
`backend/compose.vps.yaml`, Payment và PostgreSQL của nó vẫn ở profile
`payment-later`; phải bật profile này (và cấu hình PayOS) trước khi dùng trên server.

`@nrapp/observability` từ repo Logger cung cấp logger và request ID dùng chung.
Chỉ tạo thư mục khi có code dùng thật; test đặt cạnh file được kiểm tra.
