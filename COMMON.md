# Common của Payment

Điểm bắt đầu là `src/main.ts`, sau đó đến `src/core/core.module.ts` để xem
cách đăng ký middleware, guard, logger và exception filter.

Request từ Gateway: `RequestIdMiddleware` → `GatewayAuthGuard` → validation →
controller → `PaymentService` → repository PostgreSQL. Guard kiểm tra chữ ký
và gắn `request.user`; `create-qr` ký cả thông tin đơn hàng và số tiền.

Webhook công khai: `PublicRequestIdMiddleware` → `PublicRequestOutcomeMiddleware`
→ controller → service kiểm tra chữ ký Casso. Nhánh này tạo request ID mới,
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

Nghiệp vụ VietQR, chữ ký Casso và worker hết hạn nằm trong `modules/payment`.
Transaction và migrations nằm trong `modules/database`; phát sự kiện thanh toán
nằm trong `modules/outbox` và `modules/rabbitmq`.

Theo `backend/compose.vps.yaml`, Payment và PostgreSQL dành cho Payment thuộc
profile `payment-later`, chưa bật trong nhóm service VPS đang dùng vì Casso
chưa khả dụng. Code API và migrations vẫn cần giữ để bảo toàn tích hợp và dữ
liệu khi bật lại. Không có thay đổi cấu hình triển khai trong lần sắp xếp này.

`@nrapp/observability` từ repo Logger cung cấp logger và request ID dùng chung.
Chỉ tạo thư mục khi có code dùng thật; test đặt cạnh file được kiểm tra.
