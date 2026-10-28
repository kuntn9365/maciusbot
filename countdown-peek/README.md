# Countdown Peek

Extension Chrome (Manifest V3) giả lập giờ trình duyệt **cho từng website**, để xem trước nội dung bị khoá sau countdown mà không cần chỉnh giờ máy Mac.

## Cài đặt

1. Mở `chrome://extensions` (Chrome, Brave, Edge, Arc đều dùng được).
2. Bật **Developer mode** (góc trên bên phải).
3. Bấm **Load unpacked** → chọn thư mục `countdown-peek`.
4. Ghim icon Countdown Peek lên thanh công cụ.

## Dùng

Ví dụ với `https://www.hydrex.fi/hydropump`:

1. Mở trang, bấm icon extension. Popup **tự dò countdown** và điền sẵn mốc = lúc countdown về 0 (+2 giây). Nhận được:
   - `05:31:42`, `2:05:31:42`, `31:42` (chỉ lấy số đang giảm dần, nên đồng hồ thường không bị nhận nhầm)
   - `02 Days 05 Hours 31 Minutes 42 Seconds`, `5d 3h 31m 42s`, `Ngày / Giờ / Phút / Giây`
   - Dòng chữ `opens at 17:00 UTC`, `Launching Monday at 16:00 UTC` → mốc được làm tròn khớp đúng giờ đó.
   Không dò được thì nhập tay: tick **UTC** rồi nhập đúng giờ trang ghi (ví dụ `17:00:05`).
2. Bấm **Áp dụng** → trang tự tải lại với giờ giả. Popup kiểm tra lại trang và báo:
   - *Countdown trên trang đã hết* → OK.
   - *Mốc chưa đủ xa* → chọn mốc muộn hơn.
   - *Trang vẫn đếm ngược y như cũ* → trang lấy giờ từ server/API, extension không qua được.
3. Bấm **Tắt** để trang dùng lại giờ thật.

Popup từ chối mốc nằm trong ±2 phút quanh giờ thật vì mốc đó không làm trang thay đổi gì.

Các chế độ:

- **Nhảy tới mốc**: mỗi lần tải trang, đồng hồ bắt đầu từ mốc đã chọn rồi chạy tiếp.
- **Cộng thêm**: giờ trang = giờ thật + N ngày/giờ/phút (nhập số âm để lùi giờ).
- **Đóng băng thời gian**: đồng hồ trang đứng yên tại mốc.

Icon hiện badge `ON` ở tab đang dùng giờ giả. Danh sách **Site đang bật** ở cuối popup để xoá nhanh.

## Cách hoạt động

- `src/inject.js` chạy trong MAIN world của trang tại `document_start` (trước mọi script của trang) và thay `Date`, `Date.now()`, `Intl.DateTimeFormat#format/formatToParts` (khi gọi không có tham số), `performance.timeOrigin`, `Temporal.Now` (nếu trình duyệt có), và header HTTP `Date` đọc qua `fetch` (`Headers#get`) / `XMLHttpRequest` (trang hay dùng header này để đồng bộ giờ server). Các hàm bị thay vẫn trả về `[native code]` khi `toString()`.
- Cấu hình lưu trong `chrome.storage.local` theo hostname, được `src/bridge.js` mirror sang `localStorage` của trang để `inject.js` đọc đồng bộ ngay từ lần gọi `Date` đầu tiên. Đổi cấu hình khi trang đang mở cũng cập nhật live (không cần reload), nhưng nên reload vì nhiều app chỉ kiểm tra "đã launch chưa" lúc mount.
- Iframe theo cấu hình của trang cha.

## Giới hạn

Chỉ đánh lừa được countdown **tính ở phía trình duyệt** (đúng như trường hợp chỉnh giờ máy Mac xem được). Không có tác dụng nếu:

- Server trả giờ trong nội dung API (JSON `serverTime`…) hoặc chỉ trả nội dung sau giờ launch (API, SSR có kiểm tra giờ). Header `Date` thì đã được xử lý.
- Trang lấy giờ từ Web Worker hoặc từ API bên ngoài (worldtimeapi, block timestamp on-chain…).
- Contract/on-chain chưa mở: xem được giao diện nhưng giao dịch vẫn bị từ chối.
