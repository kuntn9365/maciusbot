# Countdown Peek: bàn giao để sửa tiếp trên máy Mac

## Trạng thái hiện tại

- Repo `kuntn9365/maciusbot`, branch `claude/peaceful-thompson-7ep1ms`.
- Lấy code về máy: `git fetch origin && git checkout claude/peaceful-thompson-7ep1ms`.
- Extension nằm ở thư mục `countdown-peek/`, phiên bản **1.2.2**.
- Test e2e nằm ở `tests/countdown-peek/`. Toàn bộ pass (28/10, chạy 3 lượt liền trên Mac): core 23, detect 22, v3 28, peel 37.

| File | Vai trò |
|---|---|
| `countdown-peek/src/inject.js` | Chạy trong MAIN world lúc `document_start`. Thay `Date`, `Intl` (format không tham số), `performance.timeOrigin`, `Temporal.Now`, và header HTTP `Date` của response (fetch `get`/`entries`/`forEach`, XHR). Config đọc đồng bộ từ `localStorage['__countdown_peek__']`, chỉ dùng khi `cfg.host === topHost`. |
| `countdown-peek/src/registry.js` | `syncInjectRegistration()`: đăng ký `inject.js` bằng `chrome.scripting.registerContentScripts` **chỉ cho các host đang bật**. Gọi từ popup sau mọi lần ghi `sites`, và từ background khi `onInstalled`/`onStartup`. |
| `countdown-peek/src/bridge.js` | Chạy trong ISOLATED world trên mọi trang. Mirror `chrome.storage.local.sites[topHost]` sang localStorage (có kèm `host`). Đẩy cập nhật live qua event `__countdown_peek_update__`. Cho popup gọi `globalThis.__countdownPeek.push`. |
| `countdown-peek/src/background.js` | Hiện badge ON, đăng ký lại script khi cài đặt/khởi động. |
| `countdown-peek/popup/popup.js` | Giao diện chính: dò countdown, áp dụng, `verify()` sau khi áp dụng. |
| `countdown-peek/popup/peel.js` | `peelPage('auto'\|'zap'\|'restore')`: gỡ lớp phủ maintenance/coming-soon. |

## Đã sửa trong 1.2.2: popup áp dụng mốc mặc định now+1h thay vì mốc dò được

Hiện tượng (28/10, hoodora.online): popup báo ON nhưng trang vẫn `03:42:49`. Đồng hồ giả chạy đúng; mốc đã lưu là giá trị mặc định `now+1h`, không phải mốc dò được.

Đã sửa trong `popup/popup.js`:

1. Nút **Áp dụng**/**Tắt** không còn tính là "người dùng sửa form". `apply()` chờ auto-detect xong (`await state.detecting`) rồi mới đọc `state.target`.
2. Site đã bật mà countdown vẫn chạy: `detect({ prefillIfLive: true })` tự điền mốc mới và báo "Trang vẫn còn countdown … → đã điền mốc mới …, bấm Áp dụng."
3. `state.detected = { end, target }` (theo đồng hồ trang) lưu từ lần dò gần nhất có countdown đang chạy. Chế độ "Nhảy tới mốc" mà `cfg.target < end` thì chặn, điền lại mốc dò được. Chặn này đứng sau chặn ±2 phút.
4. `targetFrom()`: khớp dòng chữ "HH:MM UTC" khi countdown kết thúc trễ hơn chữ tối đa `SNAP_SLACK` = 1,5 s. Trước đây `Math.max(hint, end)` làm mốc thành `:03`, vì trang đồng bộ giờ qua header `Date` (chỉ chính xác tới giây) chạy chậm tới 1 s. Test `[fetchdate]` vì thế từng fail ngẫu nhiên.

Test mới trong `e2e-v3.mjs` (12–15): đều FAIL trên code 1.2.1, PASS trên 1.2.2.
- 12: site đã bật với mốc now+1h, trang còn countdown → popup tự điền giờ mở +2 s; Áp dụng → "đã hết".
- 13: bấm Áp dụng lúc popup đang dò → lưu mốc dò được, không phải now+1h.
- 14: tự nhập mốc trước giờ mở → bị chặn, ô mốc thành mốc dò được, chưa lưu gì; bấm lần nữa → "đã hết".
- 15: unit test `targetFrom` (trễ 0,8/1,2/1,5/3 s, countdown theo phút).

Sửa harness:
- Playwright 1.64.1 (bản mà `^1.56.1` cài ra ngày 28/10) dùng `chromium-headless-shell` khi `headless: true`, mà bản đó không nạp extension (đã thử: chờ service worker quá 30 s). Các file e2e giờ dùng `channel: 'chromium'` (trừ khi đặt `CHROMIUM`).
- `clearSites()` của `e2e-detect.mjs` không gọi `syncInjectRegistration()`. Vì vậy `inject.js` vẫn đăng ký, và lần tải đầu đọc mirror `localStorage` của test trước (đã đo: lệch +24 h ở lần tải đầu). Đó là nguyên nhân `[xhrdate] baseline gated` fail chập chờn.

## Chạy test

```bash
cd tests/countdown-peek
npm install                  # cài playwright
npx playwright install chromium
npm test                     # chạy e2e-core, e2e-detect, e2e-v3, peel
# Tuỳ chọn: EXT=/đường/dẫn/extension  CHROMIUM=/đường/dẫn/chromium
```

- Test mở Chromium headless, nạp extension và dựng server local.
- Popup được test bằng cách mở `chrome-extension://<id>/popup/popup.html` trong một tab, rồi stub `chrome.tabs.query` để trỏ vào tab của trang test (xem hàm `openPopup`).
- Các trang mẫu nằm trong `site/`:
  - `hoodora.html?t=<ms>&mode=client|fetchdate|xhrdate|api`
  - `countdown.html` (dạng Days/Hours/Minutes/Seconds)
  - `cd2.html?fmt=days|flex|shadow|decr|colon`
  - `maint.html?layout=2&rerender=1`
  - `clock.html`

## Hoodora: kết luận đến giờ

- Màn countdown "OPENING SOON" được tính ở client, extension qua được. Ảnh lúc 17:00:27 UTC giả đã hiện màn MAINTENANCE.
- Màn **MAINTENANCE** nhiều khả năng do server quyết định. Đây là suy luận, chưa xác minh vì từ máy cloud không vào được hoodora.online. Trang ghi "refreshes by itself when the game is open again", tức là đang hỏi server liên tục.
- Đổi giờ trình duyệt không qua được màn này. Chỉ dùng **Gỡ lớp phủ** để nhìn phần giao diện phía sau. Muốn biết chắc: mở DevTools → Network xem request nào được gọi lặp lại và nó trả về gì.

## Việc còn tồn (chưa làm)

- Web Worker và `performance.timing.navigationStart` chưa được đổi giờ. Trang đếm bằng các nguồn này sẽ bị `verify()` báo nhầm là "server/API".
- Iframe khác host với trang chính không được đổi giờ, do `inject.js` chỉ đăng ký theo host của frame.
- Nhãn countdown vẽ bằng CSS `::after` không đọc được. Khi đó `verify()` sẽ báo "Không thấy countdown nào để kiểm tra".
- Gỡ lớp phủ không tự áp dụng lại sau khi tải lại trang. Có thể thêm tuỳ chọn tự gỡ cho từng site (`cfg.peel`), nhưng cần chuyển `peel.js` thành content script.
- Mirror `localStorage` theo origin, còn cấu hình theo hostname. Hai origin cùng host (http/https, khác cổng) có thể giữ bản sao cũ, nên lần tải đầu trên origin kia chạy theo cấu hình cũ cho tới khi `bridge.js` cập nhật. Popup luôn đẩy cấu hình vào tab đang mở nên đường dùng thường không gặp. (Suy ra từ code, chưa dựng test.)
- Site gọi giờ từ server/API vẫn bị popup tự điền mốc mới mỗi lần mở (countdown vẫn chạy). Bấm Áp dụng thì `verify()` báo đúng "server/API".
