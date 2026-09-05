# CI trên GitHub

Workflow [ci.yml](workflows/ci.yml) chạy khi push code, mở/cập nhật Pull Request
hoặc chọn **Actions → CI → Run workflow** (khi workflow đã có trên nhánh mặc định).

CI dùng Node.js 22, cài dependency bằng `npm ci`, rồi chạy lint, unit test và
build. Lỗi ở bước nào sẽ làm CI thất bại. CI không deploy, không chạy migration
và không cần VPS, database, RabbitMQ hay file `.env` thật.

## Package observability dùng chung

Repo này phụ thuộc `file:../logger/packages/observability`. Runner checkout hai
repo theo cấu trúc:

```text
workspace/
├── service/  ← repo hiện tại
└── logger/   ← lethanh2006/Logger, chỉ lấy packages/observability
```

Workflow mặc định dùng commit Logger
`108e1a5543a8182c3e00630fde73d2325a030dfd` để các lần chạy dùng cùng phiên bản.
Khi cập nhật shared package, push Logger trước rồi đổi `LOGGER_REF` sang commit
mới trong **Settings → Secrets and variables → Actions → Variables**, hoặc sửa
SHA mặc định trong workflow. Push service hoặc chạy lại CI để kiểm tra phiên bản
mới; push Logger không tự kích hoạt CI của repo này.

Cấu hình tùy chọn:

| Loại | Tên | Khi nào dùng |
| --- | --- | --- |
| Variable | `LOGGER_REPOSITORY` | Logger chuyển repo; giá trị dạng `owner/repo`. |
| Variable | `LOGGER_REF` | Nâng phiên bản Logger; nên dùng commit SHA đầy đủ. |
| Secret | `LOGGER_READ_TOKEN` | Logger là private; dùng fine-grained PAT có quyền **Contents: Read-only** trên repo Logger. |

Token mặc định của GitHub Actions chỉ có quyền trên repo đang chạy. Với Logger
public không cần tạo secret; với Logger private, thêm `LOGGER_READ_TOKEN` ở từng
repo service (hoặc organization secret được cấp cho các repo này). Không đặt
token trực tiếp trong YAML.

## Chạy tương tự ở local

Từ thư mục service, với repo Logger nằm bên cạnh:

```bash
npm ci --prefix ../logger/packages/observability --no-audit --no-fund
npm ci --no-audit --no-fund
npm run lint
CI=true NODE_ENV=test OBSERVABILITY_LOAD_DOTENV=false OTEL_SDK_DISABLED=true LOG_FORMAT=json npm test -- --ci --runInBand
npm run build
```

Không có bước smoke test/e2e cần hạ tầng trong workflow này. Kết quả từng bước
hiển thị trong tab **Actions** và phần **Checks** của Pull Request.

Tham khảo: [GitHub Actions cho Node.js](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs),
[checkout nhiều repo](https://github.com/actions/checkout#checkout-multiple-repos-side-by-side).
