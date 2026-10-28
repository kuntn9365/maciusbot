# Countdown Peek: bàn giao để sửa tiếp trên máy Mac

## Trạng thái hiện tại

- Repo `kuntn9365/maciusbot`, branch `claude/peaceful-thompson-7ep1ms`.
- Lấy code về máy: `git fetch origin && git checkout claude/peaceful-thompson-7ep1ms`.
- Extension nằm ở thư mục `countdown-peek/`, phiên bản **1.2.1** (commit `0a8cb0f`).
- Test e2e nằm ở `tests/countdown-peek/`. Lúc bàn giao toàn bộ đều pass: core 23, detect 22, v3 22, peel 37.

| File | Vai trò |
|---|---|
| `countdown-peek/src/inject.js` | Chạy trong MAIN world lúc `document_start`. Thay `Date`, `Intl` (format không tham số), `performance.timeOrigin`, `Temporal.Now`, và header HTTP `Date` của response (fetch `get`/`entries`/`forEach`, XHR). Config đọc đồng bộ từ `localStorage['__countdown_peek__']`, chỉ dùng khi `cfg.host === topHost`. |
| `countdown-peek/src/registry.js` | `syncInjectRegistration()`: đăng ký `inject.js` bằng `chrome.scripting.registerContentScripts` **chỉ cho các host đang bật**. Gọi từ popup sau mọi lần ghi `sites`, và từ background khi `onInstalled`/`onStartup`. |
| `countdown-peek/src/bridge.js` | Chạy trong ISOLATED world trên mọi trang. Mirror `chrome.storage.local.sites[topHost]` sang localStorage (có kèm `host`). Đẩy cập nhật live qua event `__countdown_peek_update__`. Cho popup gọi `globalThis.__countdownPeek.push`. |
| `countdown-peek/src/background.js` | Hiện badge ON, đăng ký lại script khi cài đặt/khởi động. |
| `countdown-peek/popup/popup.js` | Giao diện chính: dò countdown, áp dụng, `verify()` sau khi áp dụng. |
| `countdown-peek/popup/peel.js` | `peelPage('auto'\|'zap'\|'restore')`: gỡ lớp phủ maintenance/coming-soon. |

## Bug đang sửa dở: "bản mới còn tệ hơn" (ảnh chụp lúc 12:17 UTC ngày 28/10)

**Hiện tượng.** Trang hoodora.online vẫn hiện OPENING SOON, còn `03:42:49`, dù popup báo ON.

**Đã xác định: đồng hồ giả vẫn chạy đúng.**
- Giờ thật lúc chụp là 12:17 UTC.
- Popup báo "Giờ trên trang 20:17:10" (UTC+7), tức 13:17 UTC.
- 17:00 − 03:42:49 = 13:17:11 UTC, khớp đúng giờ trên trang.

Vậy trang đang được cộng đúng +1 giờ. Cái sai nằm ở **mốc đã áp dụng là `20:17:00` local**. Đó là giá trị mặc định `Math.ceil(now/60s)*60s + 1h` (`popup.js` khoảng dòng 648), không phải mốc dò được. Dòng dò countdown vẫn đúng ("còn 3h42m52s · khớp 17:00 UTC → gợi ý mốc 00:00:02 29/10"), nhưng chỉ hiện ra dưới dạng *gợi ý*.

**Nguyên nhân trong `popup/popup.js`:**

1. Nút **Áp dụng** gọi `touch()` (khoảng dòng 677–680). Nếu bấm lúc auto-detect đang lấy mẫu (~1,5 giây), `detect()` thấy `state.touched` nên không điền mốc. `apply()` đọc `state.target` ngay lúc bấm, nên lấy luôn giá trị mặc định +1h.
2. Site đã bật thì `init()` gọi `detect({ auto: true, prefill: !cfg })` (dòng 694), tức `prefill: false`. Mốc dò được chỉ hiện chữ "gợi ý … (bấm Dò countdown để dùng)". Nếu trang vẫn còn countdown thì mốc đang lưu rõ ràng không đủ, nhưng popup vẫn giữ nó.
3. Không có chốt chặn cho mốc nằm **trước** giờ mở đã dò được. Chốt hiện tại chỉ chặn mốc trong khoảng ±2 phút quanh giờ thật.

**Cách sửa đã lên kế hoạch (chưa code):**

```js
// (1) init(): nút Áp dụng/Tắt không tính là "người dùng sửa form"
$('apply').addEventListener('click', () => apply().catch((e) => setMsg(e.message, 'err')));
$('disable').addEventListener('click', () => disable().catch((e) => setMsg(e.message, 'err')));

// (1b) apply(): chờ auto-detect xong TRƯỚC khi đọc state.target
async function apply() {
  if (state.detecting) {
    setMsg('Đang dò countdown…');
    await state.detecting; // detect() sẽ điền mốc nếu người dùng chưa sửa gì
  }
  const realNow = Date.now();
  const cfg = { ... };
  ...
}

// (2) detect(): điền mốc kể cả khi site đã bật, miễn là countdown vẫn đang chạy
// (còn chạy = mốc đang lưu không đủ). Gọi từ init(): detect({ auto: true, prefill: !cfg, prefillIfLive: true })
const canFill = (prefill || (prefillIfLive && r.live && r.remaining > 0)) && !(auto && state.touched);
// Thông báo khi site đã bật:
// `Trang vẫn còn countdown ${fmtDuration(r.remaining)} → đã điền mốc mới ${fmt(target)}, bấm Áp dụng`

// (3) apply(): lưu giờ mở dò được (state.detectedEnd = end, set trong targetFrom/detect).
// Chế độ "Nhảy tới mốc" mà cfg.target < state.detectedEnd thì chặn lại và tự điền mốc dò được:
if (cfg.mode === 'absolute' && state.detectedEnd && cfg.target < state.detectedEnd) {
  state.target = state.detectedTarget;
  setUtc(state.utc);
  setMsg(`Mốc này vẫn trước giờ mở (${fmt(state.detectedEnd)}), trang sẽ vẫn đếm ngược. Đã đổi thành ${fmt(state.target)}, bấm Áp dụng lần nữa.`, 'err');
  return;
}
```

Lưu ý: `state.detectedEnd`/`detectedTarget` là giờ **theo đồng hồ của trang**, tính bằng `pageNow + remaining`. So với `cfg.target` trong chế độ "Nhảy tới mốc" là đúng, vì mốc đặt chính là đồng hồ trang. Chế độ "Cộng thêm" thì bỏ qua chốt này.

**Test cần thêm vào `tests/countdown-peek/e2e-v3.mjs`:**
- Site đã bật với mốc cũ, ví dụ now+1h, trang `hoodora.html?t=now+5h31m` vẫn còn countdown. Mở popup → ô mốc phải tự đổi sang giờ mở +2s. Bấm Áp dụng → "Countdown trên trang đã hết".
- Site chưa bật, bấm Áp dụng ngay khi popup vừa mở (đang dò) → phải dùng mốc dò được, không dùng now+1h.
- Tự nhập mốc trước giờ mở → bị chặn và ô mốc được thay bằng mốc dò được.
- Chạy lại cả 4 file test, không được có FAIL nào.

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
- Toàn bộ kết quả review đối kháng (3 hướng: page patch, dò countdown, popup) đã sửa xong trong 1.2/1.2.1. Lỗi duy nhất còn lại là bug ở trên.
