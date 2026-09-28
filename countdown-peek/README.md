# Countdown Peek

Extension Chrome (Manifest V3) giả lập giờ trình duyệt **cho từng website**, để xem trước nội dung bị khoá sau countdown mà không cần chỉnh giờ máy Mac.

## Cài đặt

1. Mở `chrome://extensions` (Chrome, Brave, Edge, Arc đều dùng được).
2. Bật **Developer mode** (góc trên bên phải).
3. Bấm **Load unpacked** → chọn thư mục `countdown-peek`.
4. Ghim icon Countdown Peek lên thanh công cụ.

## Dùng

Ví dụ với `https://www.hydrex.fi/hydropump`:

1. Mở trang, bấm icon extension.
2. Bấm **Dò countdown**: extension đọc số `Days / Hours / Minutes / Seconds` trên trang và điền mốc = lúc countdown về 0 (+2 giây).
   Hoặc nhập mốc bằng tay (tick **UTC** để nhập đúng giờ như trang ghi, ví dụ `16:00 UTC`).
3. Bấm **Áp dụng** → trang tự tải lại với giờ giả, countdown hết và nội dung hiện ra.
4. Bấm **Tắt** để trang dùng lại giờ thật.

Các chế độ:

- **Nhảy tới mốc**: mỗi lần tải trang, đồng hồ bắt đầu từ mốc đã chọn rồi chạy tiếp.
- **Cộng thêm**: giờ trang = giờ thật + N ngày/giờ/phút (nhập số âm để lùi giờ).
- **Đóng băng thời gian**: đồng hồ trang đứng yên tại mốc.

Icon hiện badge `ON` ở tab đang dùng giờ giả. Danh sách **Site đang bật** ở cuối popup để xoá nhanh.

## Cách hoạt động

- `src/inject.js` chạy trong MAIN world của trang tại `document_start` (trước mọi script của trang) và thay `Date`, `Date.now()`, `Intl.DateTimeFormat#format/formatToParts` (khi gọi không có tham số) và `Temporal.Now` (nếu trình duyệt có). Các hàm bị thay vẫn trả về `[native code]` khi `toString()`.
- Cấu hình lưu trong `chrome.storage.local` theo hostname, được `src/bridge.js` mirror sang `localStorage` của trang để `inject.js` đọc đồng bộ ngay từ lần gọi `Date` đầu tiên. Đổi cấu hình khi trang đang mở cũng cập nhật live (không cần reload), nhưng nên reload vì nhiều app chỉ kiểm tra "đã launch chưa" lúc mount.
- Iframe theo cấu hình của trang cha.

## Giới hạn

Chỉ đánh lừa được countdown **tính ở phía trình duyệt** (đúng như trường hợp chỉnh giờ máy Mac xem được). Không có tác dụng nếu:

- Server tự trả thời gian / chỉ trả nội dung sau giờ launch (API, SSR có kiểm tra giờ).
- Trang lấy giờ từ Web Worker hoặc từ API bên ngoài (worldtimeapi, block timestamp on-chain…).
- Contract/on-chain chưa mở: xem được giao diện nhưng giao dịch vẫn bị từ chối.
