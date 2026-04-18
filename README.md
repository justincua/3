# EA Mobile Bridge

Web app mobile-first nhận dữ liệu từ EA và tách riêng khu vực admin.

## Tính năng
- Public app ở `/` để xem bot theo kiểu mobile app
- Danh sách bot giữ **thứ tự cố định**, không nhảy theo thời gian cập nhật
- Tab **Lịch tháng** theo từng bot, hiển thị `$` và `DD` theo ngày
- Admin riêng ở `/admin`
- Export JSON all và import JSON all để chuyển Railway / VPS mà không mất dữ liệu
- Chặn Google index bằng `robots.txt`, meta noindex và header `X-Robots-Tag`
- Bảo mật admin bằng cookie HttpOnly, SameSite=Strict, rate limit login, optional IP allowlist
- Tương thích trực tiếp với EA đang gọi:
  - `GET /ea/heartbeat`
  - `GET /ea/next`
  - `GET /ea/ack`

## Cài đặt Railway / VPS
```bash
npm install
cp .env.example .env
npm start
```

## ENV quan trọng
- `EA_TOKEN`: phải giống `BridgeEaToken` trong EA
- `ADMIN_USER`
- `ADMIN_PASSWORD` hoặc `ADMIN_PASSWORD_HASH`
- `ADMIN_SESSION_SECRET`
- `DATA_DIR`: thư mục lưu JSON, ví dụ `/app/data`

## Cấu hình EA MT5
Trong EA:
- `BridgeURL = https://domain-cua-ban.com`
- `BridgeEaToken = giống EA_TOKEN`
- Thêm domain vào MT5 WebRequest allowed URLs

## Tạo hash password mạnh hơn
Dùng Node REPL hoặc file script nhỏ:
```js
const crypto = require('crypto');
const password = 'mat_khau_cua_ban';
const salt = crypto.randomBytes(16).toString('hex');
const iterations = 120000;
const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
console.log(`pbkdf2_sha256$${iterations}$${salt}$${hash}`);
```
Sau đó bỏ `ADMIN_PASSWORD`, dùng `ADMIN_PASSWORD_HASH`.

## Lưu dữ liệu
- State tổng: `DATA_DIR/bot_state.json`
- Snapshot từng bot: `DATA_DIR/bots/<botKey>.json`
- Lịch tháng tổng: `DATA_DIR/months/lich_thang_YYYY_MM.json`
- Lịch tháng theo bot: `DATA_DIR/months_by_bot/<botKey>__YYYY_MM.json`

## Backup / restore
- Export ở admin: **Export JSON all**
- Import ở admin: **Import JSON all**
- Phù hợp khi đổi Railway project, đổi VPS, hoặc khôi phục sau deploy
