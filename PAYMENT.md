# Thanh toán PayOS trong NRApp: giao dịch, tranh chấp và lỗi

Tài liệu này giải thích **phần tiền** của NRApp cho người chưa làm DevOps hay hệ thống thanh toán:
tiền đi qua những đâu, công nghệ nào giữ cho nó đúng, vì sao chọn công nghệ đó, và hệ thống làm gì
khi **hai người cùng giao dịch** hoặc khi **giao dịch thất bại**. Mỗi đảm bảo đều chỉ ra được nằm ở
file nào và được test nào chứng minh.

Cùng phong cách với [docs/DEVOPS.md](../docs/DEVOPS.md). Mỗi công nghệ được trình bày theo:
**khái niệm → vì sao chọn → áp dụng ở đâu → tối ưu được gì → tác dụng (và cái giá)**.

> **Hiện trạng (2026-11-09)**
>
> - Luồng PayOS chạy được ở máy dev và trong cụm Kubernetes thử nghiệm (`backend/k8s`). Web người
>   dùng đã có nút "Thanh toán online" (`nrapp-user-web`, trang Căn tin).
> - Ngày 2026-11-09 bổ sung: sửa một lỗi **lost update** (mục 5, tình huống 6), thêm **đối soát chủ
>   động** với PayOS (mục 7), huỷ link cũ khi bị thay, và bộ **test tranh chấp trên PostgreSQL thật**
>   (mục 8).
> - Chưa có: API hoàn tiền, huỷ link khi khách huỷ đơn, cảnh báo tự động. Xem mục 10.

## Mục lục

0. [Tóm tắt một phút](#0-tóm-tắt-một-phút)
1. [Kiến thức nền](#1-kiến-thức-nền)
2. [Kiến trúc và luồng tiền](#2-kiến-trúc-và-luồng-tiền)
3. [Vòng đời một thanh toán](#3-vòng-đời-một-thanh-toán)
4. [Công nghệ và vì sao chọn](#4-công-nghệ-và-vì-sao-chọn)
5. [Khi nhiều người, nhiều request cùng lúc](#5-khi-nhiều-người-nhiều-request-cùng-lúc)
6. [Khi giao dịch thất bại](#6-khi-giao-dịch-thất-bại)
7. [Đối soát chủ động với PayOS](#7-đối-soát-chủ-động-với-payos)
8. [Bằng chứng: test](#8-bằng-chứng-test)
9. [Vận hành: theo dõi và xử lý tay](#9-vận-hành-theo-dõi-và-xử-lý-tay)
10. [Giới hạn và việc nên làm tiếp](#10-giới-hạn-và-việc-nên-làm-tiếp)
11. [Mở rộng: chuyển tiền giữa hai tài khoản](#11-mở-rộng-chuyển-tiền-giữa-hai-tài-khoản)
12. [Câu hỏi phỏng vấn hay gặp](#12-câu-hỏi-phỏng-vấn-hay-gặp)
13. [Thuật ngữ và bản đồ file](#13-thuật-ngữ-và-bản-đồ-file)

---

## 0. Tóm tắt một phút

Những gì hệ thống **đảm bảo**, cơ chế, và bằng chứng:

| Đảm bảo | Cơ chế | Bằng chứng |
| --- | --- | --- |
| Một lần chuyển khoản chỉ được ghi nhận **đúng một lần**, dù webhook đến trùng hay đến song song | Bảng `webhook_receipts` có khóa duy nhất `(provider, provider_event_id)`, ghi bằng `INSERT ... ON CONFLICT DO NOTHING` | Test: 20 webhook trùng gửi cùng lúc → 1 `PROCESSED`, 19 `DUPLICATE`, 1 sự kiện gửi canteen |
| Mỗi đơn có **tối đa một link đang chờ** và **tối đa một thanh toán thành công** | Advisory lock theo mã đơn + 2 unique index có điều kiện trong PostgreSQL | Test: 10 request tạo link cùng lúc → 1 link |
| Tiền đã về **không bao giờ bị ghi đè** thành "hết hạn" bởi một request song song | Khóa dòng `SELECT ... FOR UPDATE` trước khi đổi trạng thái | Test 25 vòng chạy đua: **đỏ với code cũ** (`Expected SUCCESS, Received EXPIRED`), **xanh sau khi sửa** |
| Tiền đã về mà **webhook bị mất** vẫn được ghi nhận | Worker đối soát hỏi PayOS mỗi phút, ghi qua đúng đường idempotent của webhook | Unit test của worker; mã sự kiện trùng với webhook nên không ghi hai lần |
| Sự kiện "đơn đã trả" **không mất** khi RabbitMQ hay canteen đang hỏng | Outbox ghi cùng transaction, gửi lại với backoff, RabbitMQ xác nhận từng message, queue bền | Thiết kế; xem mục 6 |
| **Không ai sửa được số tiền**, kể cả client | Gateway tự đọc tổng tiền từ canteen; số tiền nằm trong chữ ký HMAC nội bộ | `gateway/.../payment.service.ts`, `payment-request-context.ts` |
| **Webhook giả** bị từ chối | HMAC-SHA256 với checksum key của PayOS, so sánh thời gian hằng | `payos-signature.ts` và spec |
| Tiền về **sai chỗ** (đơn đã huỷ, đã trả, lệch tiền, trả hai lần) không bị áp bừa vào đơn | Kiểm tra trạng thái trong transaction; chuyển sang hàng chờ đối soát tay để hoàn tiền | Test "hai người cùng chuyển tiền vào một link" |

---

## 1. Kiến thức nền

Đọc mục này nếu chưa quen các khái niệm; các mục sau dùng lại chúng.

### 1.1 Transaction và ACID

**Khái niệm.** Transaction (giao dịch database) là một nhóm thao tác **cùng thành công hoặc cùng
không có gì xảy ra**. ACID là bốn tính chất của nó:

| Chữ | Nghĩa | Ví dụ trong NRApp |
| --- | --- | --- |
| Atomicity (nguyên tử) | Tất cả hoặc không gì cả | Đánh dấu `SUCCESS` + ghi sự kiện outbox + ghi biên nhận webhook: một transaction. Payment sập giữa chừng thì cả ba biến mất, không có trạng thái "đã trả nhưng quên báo canteen" |
| Consistency (nhất quán) | Dữ liệu luôn thỏa ràng buộc | `CHECK (amount > 0)`, `CHECK (currency = 'VND')`, mỗi đơn tối đa một `SUCCESS` |
| Isolation (cô lập) | Transaction chạy song song không giẫm lên nhau | Khóa dòng, khóa advisory (mục 1.4) |
| Durability (bền) | Đã commit là còn, kể cả mất điện | PostgreSQL ghi WAL xuống đĩa trước khi báo commit |

### 1.2 Race condition và lost update

**Race condition** (tranh chấp): kết quả phụ thuộc vào việc hai luồng chạy **xen nhau theo thứ tự
nào**. Chạy thử trên máy thường không thấy, lên production với nhiều người thì thỉnh thoảng sai.

**Lost update** (mất cập nhật) là kiểu tranh chấp kinh điển:

```text
Request A: đọc payment P  → thấy PENDING
Webhook B:                     khóa P → ghi SUCCESS → commit
Request A:                                                  ghi P = EXPIRED  ← đè mất SUCCESS của B
```

Bản ghi nói "hết hạn" trong khi tiền đã về. NRApp từng có đúng lỗi này (mục 5, tình huống 6).

### 1.3 Idempotency

**Khái niệm.** Một thao tác là *idempotent* nếu làm một lần hay nhiều lần đều cho **cùng kết quả**.

**Vì sao thanh toán cần.** Mạng không đáng tin: PayOS có thể gửi cùng một webhook hai lần, client có
thể bấm "Thanh toán" hai lần, worker có thể gửi một message rồi chết trước khi kịp đánh dấu. Hệ thống
phải chịu được việc nhận **cùng một thứ nhiều lần** mà không ghi nhận tiền hai lần.

**Cách làm phổ biến:** gắn cho mỗi thao tác một **khóa idempotency** duy nhất, lưu khóa đó cùng kết
quả, gặp lại khóa thì trả kết quả cũ. NRApp dùng `<paymentLinkId>:<reference>` (mã link PayOS + mã
giao dịch ngân hàng) làm khóa cho mỗi lần tiền về.

### 1.4 Khóa trong PostgreSQL

| Loại | Khái niệm | NRApp dùng ở |
| --- | --- | --- |
| Khóa dòng `SELECT ... FOR UPDATE` (pessimistic) | Khóa các dòng vừa đọc; transaction khác muốn sửa hay khóa dòng đó phải **chờ** tới khi transaction này commit | Webhook khóa payment theo `payment_code`; `createOrReuse` khóa payment PENDING của đơn |
| `FOR UPDATE SKIP LOCKED` | Như trên nhưng dòng đang bị khóa thì **bỏ qua** thay vì chờ | Outbox: nhiều worker cùng lấy việc mà không lấy trùng |
| Advisory lock `pg_advisory_xact_lock(key)` | Khóa trên một **con số** do mình chọn, không gắn với dòng nào; tự nhả khi transaction kết thúc | Khóa theo mã đơn, để các request tạo link cho **cùng một đơn** chạy lần lượt, kể cả khi chưa có dòng nào để khóa |
| Unique constraint, unique index có điều kiện | Database **từ chối** dữ liệu vi phạm, là lớp chặn cuối cùng dù code có lỗi | `uq_payments_one_success_order`: mỗi đơn tối đa một `SUCCESS`; `uq_payments_one_pending_order`: tối đa một `PENDING` |
| Optimistic lock (cột `version`) | Không khóa; khi ghi kiểm tra `version` còn như lúc đọc không, không thì làm lại | NRApp không dùng ở payment (user service dùng version cho đồng bộ hồ sơ) |

**Vì sao chọn khóa bi quan (pessimistic) cho tiền:** xung đột trên cùng một payment hiếm nhưng hậu
quả nặng (tiền). Khóa bi quan cho kết quả chắc chắn, đơn giản để chứng minh; cái giá là request song
song trên **cùng** một đơn phải chờ vài mili giây, các đơn khác không ảnh hưởng nhau.

### 1.5 Webhook và chữ ký HMAC

**Webhook**: PayOS **chủ động gọi** vào URL công khai của NRApp để báo "đã nhận tiền". Vì URL công khai,
ai cũng gọi được, nên PayOS ký nội dung bằng **HMAC-SHA256** với *checksum key* chỉ PayOS và NRApp biết.
NRApp tính lại chữ ký, khớp mới tin. Không có key thì không giả được; sửa một ký tự là chữ ký sai.

### 1.6 At-least-once, outbox và saga

- **At-least-once** (ít nhất một lần): message chắc chắn tới, nhưng có thể tới **hơn một lần**. Đây là
  mức thực tế của mọi hệ thống phân tán; "exactly-once" thật sự đạt được bằng **at-least-once +
  bên nhận idempotent**.
- **Outbox**: thay vì vừa ghi database vừa gửi RabbitMQ (hai hệ thống, không có transaction chung),
  ghi "lá thư cần gửi" vào bảng `outbox_events` **trong cùng transaction** với thay đổi dữ liệu; một
  worker gửi đi sau. Chi tiết chung: [docs/DEVOPS.md](../docs/DEVOPS.md), mục 6.7.
- **Saga và bù trừ** (compensation): một nghiệp vụ trải qua nhiều service không có transaction chung,
  nên khi bước sau thất bại thì phải chạy **bước bù** (ví dụ hoàn tiền). NRApp hiện làm bước bù **bằng
  tay** (mục 9), chưa tự động (mục 10).

### 1.7 Đối soát (reconciliation)

So sánh sổ sách của mình với sổ sách của bên kia (PayOS, ngân hàng) để tìm chỗ lệch. Ngân hàng đối
soát hằng ngày; NRApp đối soát **mỗi phút** cho các link chưa chốt (mục 7).

---

## 2. Kiến trúc và luồng tiền

### 2.1 Sơ đồ

```text
 Web/app  ──(1) POST /api/payment/orders/:orderId/payos ──►  Gateway
                                                              │ (2) đọc đơn từ canteen bằng quyền người gọi,
                                                              │     lấy finalAmount; đơn phải CREATED + PENDING
                                                              │ (3) gọi payment create-qr, ký HMAC gồm
                                                              ▼     orderId + chủ đơn + số tiền
                                                           Payment ──(4) tạo link──► PayOS API
                                                              │ PostgreSQL: payments
 Khách quét QR, chuyển khoản ──────────────────────────► Ngân hàng ──► PayOS
                                                              │
 PayOS ──(5) POST /api/payment/webhooks/payos (công khai) ──► Gateway ──► Payment
                                                              │ (6) kiểm HMAC PayOS; MỘT transaction:
                                                              │     biên nhận + payment SUCCESS + outbox
                                                              │ (7) worker outbox ──► RabbitMQ
                                                              │        queue canteen.payment.succeeded.v1
                                                              ▼
                                                           Canteen (8) đơn → PAID / COMPLETED / PAYOS
 Worker đối soát (mỗi phút) ──(9) GET trạng thái link ──► PayOS     (lưới an toàn khi (5) bị lỡ)
 Web ──(10) hỏi trạng thái mỗi 3 giây: GET /api/payment/orders/:orderId
```

### 2.2 Từng bước, ai chịu trách nhiệm gì

| Bước | Thành phần | Việc | Vì sao đặt ở đây |
| --- | --- | --- | --- |
| 1 | Web | Chỉ gửi mã đơn, **không gửi số tiền** | Client không đáng tin: số tiền từ client là lỗ hổng sửa giá |
| 2 | Gateway | Đọc đơn từ canteen **bằng quyền của người gọi** | Người khác không đọc được đơn thì cũng không tạo được link cho đơn đó |
| 3 | Gateway | Ký HMAC `payment.create-qr.v2` gồm mã đơn, chủ đơn, số tiền | Payment chỉ tin số tiền có chữ ký Gateway; chữ ký bắt được cũng không dùng cho đơn/số tiền khác |
| 4 | Payment | Dùng lại link còn hạn hoặc tạo link mới (mã `orderCode` duy nhất, nội dung chuyển khoản ≤ 9 ký tự, hết hạn sau 15 phút) | PayOS cần `orderCode` số nguyên duy nhất; link có hạn để tiền không về một link cũ quên lãng |
| 5, 6 | Payment | Ghi nhận tiền về, idempotent, trong một transaction | Mục 5 |
| 7 | Payment | Outbox gửi `payment.succeeded.v1` | Không mất sự kiện khi RabbitMQ lỗi (mục 6) |
| 8 | Canteen | Đặt đơn đã trả; đơn huỷ, đã trả, lệch tiền thì **không đổi đơn** mà ghi log để hoàn tiền | Canteen là chủ dữ liệu đơn; payment không sửa database của service khác |
| 9 | Payment | Đối soát chủ động | Mục 7 |
| 10 | Web | Hỏi trạng thái, cập nhật giao diện khi tiền về | Người dùng không phải bấm "làm mới" |

### 2.3 Dữ liệu (PostgreSQL riêng của payment)

| Bảng | Chứa | Ràng buộc quan trọng |
| --- | --- | --- |
| `payments` | Mỗi link PayOS là một dòng: đơn, chủ đơn, số tiền, trạng thái, `payment_code` (= `orderCode` PayOS), `payment_link_id`, hạn, lúc trả, trạng thái phía PayOS (`provider_status`), lần đối soát (`reconciled_at`) | `payment_code` duy nhất; `amount > 0`; `currency = 'VND'`; **mỗi đơn tối đa một `PENDING`** và **tối đa một `SUCCESS`** (unique index có điều kiện); `provider_transaction_id` duy nhất |
| `webhook_receipts` | Mỗi lần tiền về đã xử lý: mã sự kiện, mã băm nội dung, kết quả (`PROCESSED`, `REVIEW_REQUIRED`...), lý do | **`(provider, provider_event_id)` duy nhất**: khóa idempotency |
| `outbox_events` | Sự kiện chờ gửi RabbitMQ, số lần thử, lần thử kế tiếp, lỗi cuối | Khóa ngoại tới `payments` |
| `payment_migrations` | Lịch sử migration TypeORM | |

---

## 3. Vòng đời một thanh toán

```text
                 tạo link (create-qr)
                        │
                        ▼
                    PENDING ───────────── tiền về (webhook / đối soát) ─────────► SUCCESS
                     │   │                                                          ▲
     quá 15 phút     │   │ khách huỷ trên trang PayOS                               │ tiền về muộn cho
     (worker hết hạn)│   │ (đối soát thấy CANCELLED)                                │ link đã hết hạn
     hoặc bị thay    ▼   ▼                                                          │ vẫn được ghi nhận
                  EXPIRED   CANCELLED                                               │
                     └──────────────────────────────────────────────────────────────┘
```

| Trạng thái | Nghĩa | Ai đặt | Còn nhận tiền? |
| --- | --- | --- | --- |
| `PENDING` | Link đang mở | create-qr | Có |
| `SUCCESS` | Đã ghi nhận tiền; đã xếp sự kiện cho canteen | Webhook hoặc đối soát | Lần tiền về thứ hai của cùng link: không ghi, chuyển đối soát tay để hoàn |
| `EXPIRED` | Quá hạn, hoặc bị thay bằng link mới vì đơn đổi số tiền | Worker hết hạn, create-qr | **Có**: PayOS tự khóa link theo hạn, nên tiền tới được là tiền hợp lệ của link này |
| `CANCELLED` | PayOS báo link đã huỷ | Worker đối soát | Không: tiền tới (nếu có) chuyển đối soát tay |
| `FAILED`, `REVIEW_REQUIRED`, `REFUNDED` | Có trong schema để dành cho hoàn tiền sau này | Code hiện **chưa** đặt các trạng thái này lên `payments`; các ca cần xem tay được ghi ở `webhook_receipts` | |

Mọi thay đổi trạng thái đều có **điều kiện bảo vệ** trong câu lệnh, ví dụ đối soát chỉ sửa dòng còn
`PENDING`/`EXPIRED`, nên không bao giờ hạ một `SUCCESS` xuống trạng thái khác.

---

## 4. Công nghệ và vì sao chọn

### 4.1 PostgreSQL cho tiền (không dùng MongoDB như user, chat, todo)

| | |
| --- | --- |
| Khái niệm | Cơ sở dữ liệu quan hệ: bảng, ràng buộc, transaction ACID, khóa dòng |
| Vì sao chọn | Tiền cần: transaction nhiều bảng (payment + biên nhận + outbox), ràng buộc duy nhất có điều kiện, khóa dòng, khóa advisory. MongoDB có transaction nhưng không có unique index có điều kiện kiểu `WHERE status = 'SUCCESS'` gọn như vậy, không có `SKIP LOCKED`, và cần replica set |
| Áp dụng ở đâu | Database riêng `payment-postgres` (Compose) / StatefulSet `payment-postgres` (Kubernetes) |
| Tối ưu được gì | Tính đúng: database tự chặn trạng thái sai kể cả khi code lỗi |
| Tác dụng, cái giá | Thêm một container PostgreSQL (~50 MB RAM); phải viết migration cho mọi thay đổi schema |

### 4.2 TypeORM migration

| | |
| --- | --- |
| Khái niệm | Mỗi thay đổi schema là một file có `up` (áp dụng) và `down` (gỡ), chạy theo thứ tự, ghi lại đã chạy tới đâu |
| Vì sao chọn | Schema tiền phải đổi có kiểm soát, xem lại được, quay lui được; không dùng `synchronize` (tự đổi schema theo code) vì có thể xóa cột chứa dữ liệu |
| Áp dụng ở đâu | `src/database/migrations/`; tự chạy khi service khởi động (`PAYMENT_DB_RUN_MIGRATIONS=true`), trong một transaction duy nhất (`migrationsTransactionMode: 'all'`) |
| Tác dụng | Ngày 2026-11-09, migration `AddPayosReconciliation1724000004000` (thêm trạng thái `CANCELLED`, cột `provider_status`, `reconciled_at`) tự chạy khi rolling update payment trong cụm Kubernetes, không cần thao tác tay |

### 4.3 PayOS (cổng thanh toán)

| | |
| --- | --- |
| Khái niệm | Dịch vụ tạo link và mã VietQR cho tài khoản ngân hàng, tự khớp tiền về với link và gọi webhook |
| Vì sao chọn | Phương án cũ (VietQR tĩnh + Casso đọc sao kê) phải tự khớp nội dung chuyển khoản; PayOS khớp sẵn theo `orderCode`, có API tra cứu (dùng cho đối soát), có huỷ link, có chữ ký ở cả request lẫn webhook |
| Áp dụng ở đâu | `payos.client.ts` (tạo, huỷ, tra cứu link), `payos-signature.ts` (ký và kiểm chữ ký) |
| Cái giá | Phụ thuộc bên thứ ba: PayOS chậm hay lỗi thì không tạo được link (khách vẫn trả tiền mặt được); webhook cần URL HTTPS công khai |

### 4.4 RabbitMQ + outbox (báo canteen)

| | |
| --- | --- |
| Khái niệm | Hàng đợi message bền; outbox là bảng sự kiện ghi cùng transaction rồi gửi sau |
| Vì sao chọn | Gọi HTTP thẳng sang canteen sẽ mất sự kiện nếu canteen đang tắt. Hàng đợi giữ message tới khi canteen nhận |
| Áp dụng ở đâu | `modules/outbox/outbox.publisher.ts`: lấy việc bằng `FOR UPDATE SKIP LOCKED`, giữ chỗ 30 giây, gửi với `messageId` = mã sự kiện, message `persistent`, chờ RabbitMQ xác nhận (*publisher confirm*), lỗi thì thử lại sau `min(300, 2^n)` giây |
| Tối ưu được gì | Không mất sự kiện; nhiều bản sao payment chạy song song không gửi trùng |
| Cái giá | Canteen cập nhật đơn **trễ** khoảng 1 giây so với lúc tiền về (nhất quán sau cùng); bên nhận phải idempotent |

### 4.5 HMAC (hai nơi)

| | |
| --- | --- |
| Khái niệm | Chữ ký tính từ nội dung + khóa bí mật chung |
| Áp dụng ở đâu | (1) Gateway → payment: ký danh tính người gọi, và với `create-qr` ký thêm đơn + số tiền. (2) PayOS → payment: webhook ký bằng checksum key; response tạo link cũng được kiểm chữ ký |
| Chi tiết an toàn | So chữ ký bằng `timingSafeEqual` (thời gian so sánh không phụ thuộc vị trí ký tự sai, chống đoán dần chữ ký); chuỗi ký sắp khóa theo đúng thuật toán của SDK PayOS |
| Không ký ở đâu | API tra cứu link khi đối soát: đây là request **mình chủ động gửi** tới PayOS qua HTTPS kèm API key, nên tin được nguồn; webhook thì ai cũng gửi được nên bắt buộc ký |

### 4.6 Khóa và ràng buộc (đã giải thích ở mục 1.4)

Tóm tắt lựa chọn: **advisory lock** cho "mọi thao tác tạo link của một đơn" (chưa chắc có dòng để
khóa), **khóa dòng** cho "một payment cụ thể", **unique index có điều kiện** làm lưới chặn cuối,
**`SKIP LOCKED`** cho hàng đợi công việc.

---

## 5. Khi nhiều người, nhiều request cùng lúc

Mỗi dòng: điều có thể sai nếu không cẩn thận, cơ chế chặn, kết quả cuối cùng, và bằng chứng.

| # | Tình huống | Có thể sai thế nào | Cơ chế | Kết quả | Bằng chứng |
| --- | --- | --- | --- | --- | --- |
| 1 | Khách bấm "Thanh toán online" hai lần, hoặc mở hai tab | Hai link PayOS cho một đơn, khách trả cả hai | Advisory lock theo mã đơn; request sau thấy link `PENDING` còn hạn cùng số tiền thì **dùng lại**; link PayOS thừa vừa tạo bị huỷ | Một link | Concurrency test 1 (10 request cùng lúc → 1 link); unit test "huỷ link vừa tạo khi request song song đã giữ link khác" |
| 2 | Khách và thu ngân cùng tạo link cho một đơn | Như trên | Như trên; thu ngân có quyền tạo link cho đơn của khách (`admin`, `manager`, `cashier`) | Một link, cả hai thấy cùng mã QR | Như trên |
| 3 | **Hai người cùng quét một mã QR và cùng chuyển tiền** | Đơn bị ghi nhận hai lần, hoặc lần sau đè lần trước | Mỗi lần tiền về có mã sự kiện riêng. Webhook khóa dòng payment; lần thứ nhất ghi `SUCCESS`, lần thứ hai thấy đã `SUCCESS` nên **không ghi**, biên nhận chuyển `REVIEW_REQUIRED` để hoàn tiền | Một `SUCCESS`, một sự kiện cho canteen, một khoản chờ hoàn | Concurrency test 3 |
| 4 | PayOS gửi **cùng một webhook nhiều lần**, có khi đồng thời | Ghi nhận tiền nhiều lần, báo canteen nhiều lần | `INSERT INTO webhook_receipts ... ON CONFLICT DO NOTHING` trên khóa duy nhất `(provider, provider_event_id)`. Hai insert đồng thời: insert sau **chờ** insert trước commit rồi mới biết là trùng | Một `PROCESSED`, còn lại `DUPLICATE` | Concurrency test 2 (20 webhook đồng thời) |
| 5 | Tiền về đúng lúc worker đánh dấu link hết hạn | Tiền về cho link vừa bị đánh `EXPIRED` bị từ chối | Hai bên tranh cùng một dòng nên chạy lần lượt; webhook chấp nhận cả `PENDING` lẫn `EXPIRED` | Tiền được ghi nhận | Unit test `validatePayosTransaction` |
| 6 | **Tiền về đúng lúc cấp link mới cho đơn** (đơn đổi số tiền) | **Lost update**: request cấp link đọc payment là `PENDING` (không khóa), webhook ghi `SUCCESS`, rồi request ghi đè `EXPIRED`. Tiền đã về nhưng hệ thống nói "hết hạn" | **Sửa ngày 2026-11-09**: `createOrReuse` khóa dòng `PENDING` bằng `FOR UPDATE` rồi mới đọc lại `SUCCESS`. Webhook đang giữ khóa thì request chờ; sau khi chờ, PostgreSQL kiểm lại điều kiện `status = 'PENDING'` trên bản mới nên thấy đã `SUCCESS` và trả về luôn | `SUCCESS` được giữ | Concurrency test 4: 25 vòng chạy đua. **Code cũ: đỏ** (`Expected: "SUCCESS"`, `Received: "EXPIRED"`). **Code mới: xanh** |
| 7 | Webhook và worker đối soát **cùng báo một giao dịch** | Ghi nhận hai lần | Cả hai nguồn tạo **cùng mã sự kiện** `<paymentLinkId>:<reference>` và cùng mã băm nội dung, đi qua cùng một hàm `recordPayosTransaction` | Lần sau là `DUPLICATE` | Unit test "webhook và đối soát cho cùng mã sự kiện, cùng mã băm" |
| 8 | Đối soát chốt `CANCELLED` đúng lúc tiền về | Payment vừa `CANCELLED` vừa báo canteen là đã trả | Câu `UPDATE` của đối soát có điều kiện `status IN ('PENDING','EXPIRED')`; webhook khóa dòng. Hai bên chạy lần lượt | Hoặc tiền về trước: `SUCCESS` + 1 sự kiện. Hoặc huỷ trước: `CANCELLED` + 0 sự kiện, khoản tiền chờ hoàn. **Không bao giờ** lẫn lộn | Concurrency test 5 (25 vòng) |
| 9 | Thu ngân bấm "đã thu tiền mặt" đúng lúc PayOS báo đã trả | Đơn bị trả hai lần mà không ai biết | Canteen cập nhật đơn bằng câu lệnh có điều kiện (`paymentStatus = 'PENDING'`). Bên thắng ghi; bên thua: thu ngân nhận lỗi 409, hoặc sự kiện PayOS bị ghi log `canteen.payment.unapplied` để hoàn tiền | Đơn chỉ được trả một lần; khoản thừa có dấu vết | `canteen/src/modules/order/order-payment.service.ts` và spec |
| 10 | Khách huỷ đơn khi đang chuyển khoản | Tiền về cho đơn đã huỷ | Canteen thấy đơn `CANCELLED` thì không đổi đơn, ghi `canteen.payment.unapplied`. Web cảnh báo trong hộp thoại huỷ: "đừng chuyển khoản sau khi huỷ" | Tiền chờ hoàn tay | Spec của canteen. **Còn thiếu**: huỷ link PayOS khi huỷ đơn (mục 10) |
| 11 | Chạy **nhiều bản sao** payment (Kubernetes scale) | Hai worker gửi trùng sự kiện, hai worker hết hạn đè nhau | Outbox `SKIP LOCKED`; worker hết hạn và đối soát dùng `UPDATE` có điều kiện; mọi đường ghi tiền đều qua khóa + khóa duy nhất | An toàn; có thể tốn thêm vài lần gọi PayOS | Thiết kế |

**Cách đọc tình huống 6 bằng thời gian:**

```text
                 t1                 t2                      t3                t4
createOrReuse:   khóa advisory      SELECT ... FOR UPDATE ─── (chờ khóa) ─────► đọc lại: đã SUCCESS → trả về
webhook:              khóa dòng P ── ghi SUCCESS + outbox ── commit (nhả khóa)
```

Trước khi sửa, ở `t2` request đọc **không khóa** nên không chờ, rồi ghi `EXPIRED` sau khi webhook
commit, đè mất `SUCCESS`.

---

## 6. Khi giao dịch thất bại

| # | Sự cố | Người dùng thấy | Hệ thống làm | Dữ liệu cuối cùng |
| --- | --- | --- | --- | --- |
| 1 | PayOS không phản hồi khi tạo link (quá 10 giây) | "Chưa tạo được mã thanh toán" kèm nút **Thử lại** và **Trả tiền mặt tại quầy** | Trả 503; không lưu gì | Đơn vẫn chờ thanh toán. Nếu PayOS kịp tạo link trước khi quá giờ, link đó không ai thấy và tự hết hạn |
| 2 | PayOS từ chối (sai khóa, sai dữ liệu) | Như trên | Trả 502 kèm lý do của PayOS | Không đổi |
| 3 | Mạng đứt sau khi bấm "Thanh toán" | Web báo lỗi, bấm lại | Tạo link là idempotent theo đơn: bấm lại nhận **đúng link cũ** | Một link |
| 4 | **Webhook không tới** (server tắt lúc PayOS gọi, mạng lỗi) | Hộp thoại vẫn chờ | Worker đối soát (mục 7) hỏi PayOS sau tối đa khoảng 2 phút chờ + 1 phút chu kỳ, thấy đã trả thì ghi nhận qua đường của webhook | `SUCCESS`, canteen được báo; log `payment.reconcile.recovered` |
| 5 | Webhook sai chữ ký (giả mạo hoặc sai key) | Không ảnh hưởng | Trả 400, không ghi gì | Không đổi |
| 6 | Payment sập **giữa** transaction ghi nhận tiền | Không ảnh hưởng | PostgreSQL huỷ cả transaction, kể cả biên nhận. Lần gửi lại của PayOS (nếu có) hoặc đối soát sẽ xử lý lại từ đầu | Không có trạng thái nửa vời |
| 7 | RabbitMQ sập sau khi đã ghi `SUCCESS` | Web vẫn thấy "đã thanh toán" (đọc từ payment) | Outbox thử lại với thời gian chờ tăng dần, tối đa 5 phút một lần, mặc định không bao giờ bỏ | Canteen nhận sự kiện khi RabbitMQ lên lại |
| 8 | Canteen sập | Đơn chưa đổi "Đã thanh toán" | Message nằm trong queue bền | Đơn cập nhật khi canteen lên lại |
| 9 | Canteen lỗi database lúc áp sự kiện | Như trên | Message vào queue `.retry`, 5 giây sau thử lại; message sai định dạng vào `.dead` | Đơn cập nhật khi lỗi hết |
| 10 | Khách chuyển **thiếu hoặc thừa** tiền | Hộp thoại không báo thành công | Số tiền lệch: không ghi `SUCCESS`, biên nhận `REVIEW_REQUIRED` kèm lý do | Chờ đối soát tay |
| 11 | Khách bấm **Huỷ** trên trang PayOS | Web báo "đã huỷ thanh toán online, đơn vẫn chờ thanh toán" | Đối soát thấy link `CANCELLED` thì chốt `CANCELLED`; lần tạo QR sau cấp link mới thay vì trả lại link đã chết | Đơn vẫn chờ, tạo được link mới |
| 12 | Link hết hạn mà khách chưa trả | Hộp thoại "Mã đã hết hạn" + nút **Tạo mã mới** | Worker hết hạn đánh `EXPIRED`; tạo mã mới cấp link mới | Đơn vẫn chờ |
| 13 | Đơn đổi số tiền khi link cũ còn hạn | Nhận mã mới đúng số tiền | Link cũ chuyển `EXPIRED` và **bị huỷ phía PayOS** để khách không trả theo link cũ (thêm ngày 2026-11-09) | Một link hiệu lực |
| 14 | PostgreSQL của payment sập | Không tạo được link; trạng thái không đọc được | Request trả lỗi 5xx; webhook lỗi 5xx | Khi database lên lại, đối soát bắt các giao dịch bị lỡ |

---

## 7. Đối soát chủ động với PayOS

**Khái niệm.** Một worker chạy nền, định kỳ hỏi PayOS "link này giờ ra sao", rồi sửa sổ sách của NRApp
cho khớp. Webhook là **đường chính** (nhanh); đối soát là **lưới an toàn** (chậm hơn nhưng không phụ
thuộc việc PayOS gọi được vào NRApp).

**Vì sao cần.** Webhook là một request mạng từ PayOS vào NRApp. Nó có thể không tới khi server đang
deploy, mạng lỗi, cấu hình sai. Không đối soát thì: khách đã trả tiền, đơn vẫn "chờ thanh toán", link
hết hạn, và chỉ phát hiện khi khách khiếu nại.

**Áp dụng ở đâu.** `src/modules/payment/payment-reconciliation.worker.ts`:

1. Mỗi `PAYMENT_RECONCILE_INTERVAL_MS` (mặc định 60 giây, tối thiểu 10 giây), lấy tối đa 20 payment:
   - trạng thái `PENDING` hoặc `EXPIRED`, có `payment_link_id`;
   - tạo **trước** thời điểm hiện tại 2 phút (để webhook kịp về trước, đỡ gọi PayOS vô ích) và **sau**
     thời điểm hiện tại 24 giờ (link sống 15 phút; 24 giờ là biên rộng cho tiền về muộn);
   - trạng thái phía PayOS chưa chốt (`NULL`, `PENDING`, `PROCESSING`) và lâu hơn một chu kỳ chưa hỏi lại.
2. Với từng payment: `GET /v2/payment-requests/{paymentLinkId}` của PayOS.
3. Mỗi lần tiền về trong kết quả đi qua **`recordPayosTransaction`**, cùng hàm webhook dùng, cùng mã
   sự kiện, nên không bao giờ ghi hai lần (tình huống 7).
4. Ghi `provider_status` và `reconciled_at`; PayOS báo `CANCELLED` thì chốt `CANCELLED`, báo `EXPIRED`
   thì chốt `EXPIRED`. Câu lệnh chỉ đụng dòng còn `PENDING`/`EXPIRED` (tình huống 8).
5. Một link lỗi (PayOS từ chối, mạng chập) chỉ ghi log rồi chuyển sang link khác; lượt sau hỏi lại.

**Tối ưu được gì.** Biến "webhook mất = mất tiền khách" thành "webhook mất = chậm vài phút". Đồng thời
dọn được link khách huỷ trên trang PayOS (trước đây link đã chết vẫn bị dùng lại tới 15 phút).

**Cái giá.** Mỗi link chưa chốt tốn tối đa một lần gọi PayOS mỗi phút, chỉ trong 24 giờ đầu, mỗi lượt
tối đa 20 link.

**Log để theo dõi:**

| `event.name` | Mức | Nghĩa |
| --- | --- | --- |
| `payment.reconcile.recovered` | warn | Đối soát vừa ghi nhận tiền mà webhook không báo: nên tìm vì sao webhook lỡ |
| `payment.reconcile.cancelled` | info | Link đã bị huỷ phía PayOS |
| `payment.reconcile.mismatch` | error | PayOS báo `PAID` nhưng không có giao dịch: kiểm tra tay |
| `payment.reconcile.failed` | warn/error | Không hỏi được PayOS hoặc không đọc được database; lượt sau thử lại |

---

## 8. Bằng chứng: test

### 8.1 Unit test (chạy trong CI, không cần database)

```bash
cd payment && npm test     # 12 bộ test, 41 test (2026-11-09)
```

Các test liên quan tới mục 5 và 6: `payment.service.spec.ts` (dùng lại/huỷ link, webhook sai chữ ký,
cùng mã sự kiện từ hai nguồn, giờ PayOS), `payment-reconciliation.worker.spec.ts` (ghi nhận tiền bị lỡ,
chốt `CANCELLED`/`EXPIRED`, một link lỗi không chặn link khác, cửa sổ thời gian),
`payment.repository.spec.ts` (luật chấp nhận giao dịch), `payos-signature.spec.ts` (chữ ký).

### 8.2 Test tranh chấp trên PostgreSQL thật

Unit test với dữ liệu giả **không chứng minh được** tính đúng khi có tranh chấp: khóa, unique index và
cách PostgreSQL kiểm lại điều kiện sau khi chờ khóa chỉ có ở database thật. File
`src/modules/payment/payment.concurrency.spec.ts` chạy các transaction **thật sự song song** (pool 30
kết nối) trên một database tạm:

```bash
docker run -d --rm --name payment-test-pg -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine
cd payment
PAYMENT_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npx jest payment.concurrency
docker rm -f payment-test-pg
```

Không đặt `PAYMENT_TEST_DATABASE_URL` thì bộ test tự bỏ qua (CI không có PostgreSQL), giống cách các
service khác làm với test cần hạ tầng.

| Test | Kiểm chứng | Kết quả 2026-11-09 |
| --- | --- | --- |
| 10 request tạo link cùng lúc cho một đơn | Tình huống 1, 2 | Qua: 1 link |
| 20 webhook trùng đến cùng lúc | Tình huống 4 | Qua: 1 `PROCESSED`, 19 `DUPLICATE`, 1 sự kiện |
| Hai người cùng chuyển tiền vào một link | Tình huống 3 | Qua: 1 `PROCESSED`, 1 `REVIEW_REQUIRED`, 1 sự kiện |
| Cấp link mới đúng lúc tiền về, 25 vòng | Tình huống 6 | Qua. **Với code cũ: đỏ** (`Expected: "SUCCESS"`, `Received: "EXPIRED"`) |
| Đối soát chốt `CANCELLED` song song tiền về, 25 vòng | Tình huống 8 | Qua: chỉ có (`SUCCESS`, 1 sự kiện) hoặc (`CANCELLED`, 0 sự kiện) |

Cả 5 test chạy hết khoảng 3,5 giây.

**Vì sao "đỏ với code cũ" quan trọng:** một test tranh chấp luôn xanh có thể là test không tạo được
tranh chấp. Chạy nó trên code cũ thấy đỏ, trên code mới thấy xanh, mới chứng minh được hai điều: tranh
chấp có thật, và bản sửa chặn được nó.

### 8.3 Chưa test

- Luồng thật với PayOS (cần tài khoản và URL webhook công khai); hiện kiểm bằng `npm run test:smoke`
  và tay.
- Đối soát với API PayOS thật: unit test dùng dữ liệu giả theo cấu trúc trả về của PayOS.

---

## 9. Vận hành: theo dõi và xử lý tay

**Những khoản tiền cần người xử lý** nằm ở hai chỗ:

```sql
-- Trong database của payment: lần tiền về không ghi nhận được (trả trùng, lệch tiền, mã lạ...)
SELECT r.received_at, r.provider_event_id, r.failure_reason, p.order_id, p.amount
FROM webhook_receipts r LEFT JOIN payments p ON p.id = r.payment_id
WHERE r.status = 'REVIEW_REQUIRED'
ORDER BY r.received_at DESC;
```

```bash
# Trong log của canteen: tiền đã ghi nhận nhưng không áp được vào đơn (đơn huỷ, đã trả, lệch tiền)
kubectl -n nrapp logs deploy/canteen | grep canteen.payment.unapplied        # cụm Kubernetes
docker compose logs canteen | grep canteen.payment.unapplied                 # Compose
```

**Quy trình hoàn tiền tay hiện nay:** đối chiếu mã giao dịch (`reference`) trên trang quản lý PayOS
hoặc sao kê ngân hàng, chuyển hoàn cho khách, ghi chú lại. Khi PayOS đăng ký webhook lần đầu, nó gửi
một giao dịch thử với `orderCode` không tồn tại: giao dịch đó cũng nằm ở `REVIEW_REQUIRED`, bỏ qua được.

**Biến cấu hình:**

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `PAYMENT_INTENT_TTL_MINUTES` | 15 | Hạn của link |
| `PAYMENT_EXPIRY_INTERVAL_MS` | 60000 | Chu kỳ worker hết hạn |
| `PAYMENT_RECONCILE_INTERVAL_MS` | 60000 | Chu kỳ worker đối soát (tối thiểu 10000) |
| `PAYMENT_OUTBOX_INTERVAL_MS` | 1000 | Chu kỳ gửi outbox |
| `PAYMENT_OUTBOX_MAX_ATTEMPTS` | 0 | 0 = thử lại mãi; số dương = dừng để xử lý tay (cần có cảnh báo trước khi bật) |
| `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY`, `PAYOS_RETURN_URL`, `PAYOS_CANCEL_URL` | bắt buộc | Thiếu là service từ chối khởi động |

---

## 10. Giới hạn và việc nên làm tiếp

Xếp theo mức đáng làm trước:

| Việc | Vì sao | Hướng làm |
| --- | --- | --- |
| Huỷ link PayOS khi khách huỷ đơn | Hiện khách vẫn trả được link cũ của đơn đã huỷ (tối đa 15 phút), dẫn tới hoàn tiền tay | Gateway, sau khi canteen huỷ đơn thành công, gọi payment huỷ link `PENDING` của đơn (có chữ ký) |
| Bù trừ tự động (saga) | `canteen.payment.unapplied` chỉ là log; payment không biết khoản nào cần hoàn | Canteen phát sự kiện `canteen.payment.rejected.v1`, payment ghi trạng thái "cần hoàn tiền"; thêm API hoàn tiền |
| Metric và cảnh báo | Hiện phải đọc log mới biết có khoản cần xử lý | Đếm `REVIEW_REQUIRED`, `payment.reconcile.recovered`, outbox tồn đọng; cảnh báo khi > 0 |
| Ghi ý định trước khi gọi PayOS | Quá giờ khi tạo link có thể để lại một link PayOS mà NRApp không biết | Ghi dòng `CREATING` với `orderCode` trước, gọi PayOS sau, rồi cập nhật |
| Test với PayOS sandbox trong CI | Hiện chỉ test giả lập cấu trúc trả về | Chạy định kỳ với tài khoản thử |

---

## 11. Mở rộng: chuyển tiền giữa hai tài khoản

NRApp **không có** ví hay số dư; mục này là **thiết kế tham khảo** cho câu hỏi kinh điển của ngân hàng:
"A chuyển cho B, cùng lúc B chuyển cho A, và A bấm chuyển hai lần thì sao". Các kỹ thuật giống hệt
những gì payment đã dùng.

**1. Không đọc số dư rồi mới trừ.** Đọc `balance = 100`, kiểm tra `>= 80`, rồi ghi `balance = 20` là
lost update: hai lệnh 80 song song cùng đọc 100 và cùng qua kiểm tra. Làm trong **một câu lệnh có điều
kiện**:

```sql
UPDATE accounts SET balance = balance - 80
WHERE id = 'A' AND balance >= 80;     -- 0 dòng bị sửa = không đủ tiền
```

**2. Khóa theo thứ tự cố định để tránh deadlock.** A→B và B→A cùng lúc, mỗi bên khóa tài khoản của
mình trước thì sẽ chờ nhau mãi (deadlock). Luôn khóa theo thứ tự mã tài khoản:

```sql
SELECT * FROM accounts WHERE id IN ('A', 'B') ORDER BY id FOR UPDATE;
```

**3. Sổ kép (double-entry ledger).** Mỗi lần chuyển ghi hai dòng bút toán (A nợ 80, B có 80) trong một
transaction; tổng mọi bút toán luôn bằng 0. Số dư là tổng bút toán (có thể lưu thêm cột số dư làm bản
tóm tắt). Nhờ vậy đối soát cuối ngày chỉ cần cộng lại.

**4. Khóa idempotency cho lệnh chuyển.** Client sinh `idempotency_key` cho mỗi lệnh; bảng lệnh chuyển
có khóa duy nhất trên cột đó. Bấm hai lần, gửi lại do mạng: lần sau trả kết quả lần trước, giống
`webhook_receipts` của NRApp.

**5. Mức cô lập.** PostgreSQL mặc định `READ COMMITTED`, đủ khi đã dùng câu lệnh có điều kiện và khóa
dòng như trên. `SERIALIZABLE` an toàn hơn cho logic phức tạp nhưng transaction có thể bị huỷ với lỗi
`40001` và **phải tự thử lại**.

**6. Báo bên ngoài qua outbox, đối soát cuối ngày** như mục 4.4 và mục 7.

---

## 12. Câu hỏi phỏng vấn hay gặp

**Hỏi: Làm sao đảm bảo không trừ hay ghi nhận tiền hai lần?**
Đáp: Idempotency ở mọi điểm vào. Mỗi lần tiền về có mã duy nhất `<linkId>:<reference>`; bảng biên nhận
có khóa duy nhất trên mã đó, ghi bằng `ON CONFLICT DO NOTHING`. Database là lớp chặn cuối: unique index
"mỗi đơn tối đa một SUCCESS". Có test 20 webhook đồng thời chỉ ra 1 lần ghi nhận.

**Hỏi: Webhook không tới thì sao?**
Đáp: Webhook là đường nhanh, không phải nguồn sự thật duy nhất. Worker đối soát hỏi API của PayOS cho
mọi link chưa chốt, ghi nhận qua cùng đường idempotent, nên webhook tới muộn sau đó chỉ là bản trùng.

**Hỏi: Ghi database và gửi message, làm sao không mất một trong hai?**
Đáp: Outbox. Sự kiện ghi cùng transaction với `SUCCESS`; worker gửi với publisher confirm, lỗi thì thử
lại với backoff; bên nhận idempotent theo mã thanh toán. Kết quả là at-least-once + idempotent.

**Hỏi: Kể một lỗi tranh chấp bạn đã tìm và sửa.**
Đáp: Lost update khi cấp link mới đúng lúc webhook ghi SUCCESS (mục 5, tình huống 6). Viết test chạy
đua 25 vòng trên PostgreSQL thật, test đỏ với code cũ, sửa bằng `SELECT ... FOR UPDATE` rồi đọc lại
trạng thái, test xanh.

**Hỏi: Vì sao khóa bi quan mà không phải lạc quan (version)?**
Đáp: Xung đột trên cùng một khoản tiền hiếm nhưng hậu quả nặng; khóa bi quan cho kết quả chắc chắn và
chỉ làm chờ các request của **cùng** một đơn, vài mili giây. Khóa lạc quan hợp khi xung đột hiếm và có
thể thử lại an toàn, ví dụ sửa hồ sơ.

**Hỏi: Client gửi số tiền 1.000 đồng cho đơn 100.000 đồng thì sao?**
Đáp: Client không gửi số tiền. Gateway đọc tổng tiền từ canteen và ký nó vào HMAC nội bộ; payment chỉ
tin số tiền có chữ ký. Khi tiền về, payment so số tiền thực nhận với số tiền của link, canteen so lần
nữa với tổng đơn.

---

## 13. Thuật ngữ và bản đồ file

| Thuật ngữ | Nghĩa |
| --- | --- |
| Advisory lock | Khóa trên một con số tự chọn, không gắn với dòng nào |
| At-least-once | Message tới ít nhất một lần, có thể nhiều hơn |
| Đối soát (reconciliation) | So sổ sách của mình với bên kia để tìm chỗ lệch |
| Idempotency key | Mã duy nhất của một thao tác, gặp lại thì trả kết quả cũ |
| Lost update | Hai thao tác cùng đọc rồi cùng ghi, thao tác sau đè mất thao tác trước |
| Outbox | Bảng sự kiện ghi cùng transaction, gửi đi sau |
| Pessimistic / optimistic lock | Khóa trước rồi làm / làm rồi kiểm tra xung đột khi ghi |
| Publisher confirm | RabbitMQ xác nhận đã nhận message an toàn |
| Saga, compensation | Nghiệp vụ nhiều bước trên nhiều service; bước bù khi bước sau thất bại |
| `SKIP LOCKED` | Bỏ qua dòng đang bị khóa thay vì chờ |
| Webhook | Bên thứ ba chủ động gọi vào URL của mình để báo sự kiện |

| Muốn xem | File |
| --- | --- |
| Gateway: route, đọc đơn, ký số tiền | `gateway/src/modules/payment/payment.service.ts`, `payment-request-context.ts` |
| Tạo link, webhook, ghi giao dịch | `src/modules/payment/payment.service.ts` |
| Khóa, idempotency, điều kiện bảo vệ | `src/modules/payment/payment.repository.ts` |
| Đối soát | `src/modules/payment/payment-reconciliation.worker.ts` |
| Hết hạn link | `src/modules/payment/payment-expiry.worker.ts` |
| Gọi PayOS, chữ ký | `src/modules/payment/payos.client.ts`, `payos-signature.ts` |
| Schema, ràng buộc | `src/database/migrations/` |
| Outbox | `src/modules/outbox/outbox.publisher.ts` |
| Test tranh chấp | `src/modules/payment/payment.concurrency.spec.ts` |
| Canteen áp sự kiện | `canteen/src/modules/order/order-payment.service.ts` |
| Web: hộp thoại QR, hỏi trạng thái, quay về từ PayOS | `nrapp-user-web/app/(user)/can-tin/payos-payment-panel.tsx` |
| Chạy trong Kubernetes | `backend/k8s/apps/payment.yaml`, `backend/docs/KUBERNETES.md` |
