# CI/CD trên GitHub

Workflow trong repo này là caller mỏng; logic thực thi nằm trong Logger:

- [Reusable Node CI](https://github.com/lethanh2006/Logger/blob/3edef57e4ab192832b7a2d5465b2948592a55125/.github/workflows/reusable-node-ci.yml)
- [Reusable VPS CD](https://github.com/lethanh2006/Logger/blob/3edef57e4ab192832b7a2d5465b2948592a55125/.github/workflows/reusable-vps-cd.yml)

Caller và `platform-ref` được pin cùng full commit SHA, không dùng `@main`.
Nhờ vậy một thay đổi nền tảng không âm thầm ảnh hưởng mọi repository.

## CI

Mỗi push, Pull Request hoặc lần chạy thủ công sẽ cài dependency bằng `npm ci`,
chặn lỗ hổng production mức critical, lint, kiểm tra format, chạy test và build.
CI không cần `.env` thật hoặc các dependency runtime như MongoDB/RabbitMQ.

Chạy tương tự ở local:

```bash
npm ci --prefix ../logger/packages/observability --no-audit --no-fund
npm ci --no-audit --no-fund
npm audit --omit=dev --audit-level=critical
npm run lint
npm run format:check
npm test -- --ci --runInBand
npm run build
```

## Payment chưa có CD

Payment chỉ dùng shared CI. Không thêm `cd.yml`, không cấu hình key deploy và
không khởi động Payment/PostgreSQL trên VPS cho tới khi Casso được khôi phục và
kế hoạch migration, webhook, backup, đối soát đã được nghiệm thu.

## Nâng phiên bản nền tảng

1. Commit và push thay đổi reusable workflow/asset vào Logger.
2. Lấy full SHA Logger mới và cập nhật cả `uses:` lẫn `platform-ref` trên
   một service canary.
3. Chờ CI/CD canary và healthcheck VPS thành công.
4. Cập nhật cùng SHA cho các service còn lại.

Các chi tiết bảo mật, receiver và rollback nằm trong
[Logger README](https://github.com/lethanh2006/Logger/blob/3edef57e4ab192832b7a2d5465b2948592a55125/README.md).
