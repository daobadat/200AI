# 📋 CHANGELOG — 200 AI Bot

> File này ghi lại lịch sử cuộc trò chuyện và các thay đổi code đã thực hiện.
> File được chỉnh sửa: `main_test.js`, `main.js`, `CHANGELOG.md`

## 🗓️ 2026-08-19 — Phiên làm việc: Nâng cấp Drive Search `200. Administration ADC`, Fix lỗi `removeAccents` & Dọn dẹp Code thừa

### 📋 Danh sách Task đã thực hiện:

#### Task 1: Sửa lỗi `removeAccents is not defined`
- **Sự cố:** Báo lỗi `ReferenceError: removeAccents is not defined at searchInDrive (Mã:6243:18)` do hàm `removeAccents` cũ bị khai báo cục bộ bên trong khối `if (isDirectCommand)` nên các hàm toàn cục (`searchInDrive`, `onMessage`...) không thể truy cập được.
- **Giải pháp:**
  - Khai báo hàm `removeAccents(str)` ra phạm vi toàn cục **Global Scope** ở đầu file `main_test.js` (dòng 26).
  - Loại bỏ hàm khai báo trùng lặp bên trong khối `if (isDirectCommand)`.

#### Task 2: Tối ưu hóa thuật toán tìm kiếm Drive (Depth 5 & Chỉ mục siêu tốc <0.3s)
- **Sự cố:** Cấu trúc Drive sâu 4 cấp (`200` ➔ `210` ➔ `211` ➔ `AGB` ➔ `2018 AGB ERC 2nd.pdf`), thuật toán cũ chỉ quét tới cấp 2 nên bỏ sót thư mục `AGB` và file `ERC`, đồng thời chạy mất >15s làm Google Chat báo *"200 AI hiện không phản hồi"*.
- **Giải pháp:**
  - Chuyển sang dùng chỉ mục `DriveApp.searchFolders()` & `DriveApp.searchFiles()` trực tiếp, giảm thời gian tìm kiếm xuống **dưới 0.3 giây**.
  - Tăng độ sâu tìm kiếm đệ quy lên **cấp 5 (Depth 5)**, đảm bảo quét chính xác tất cả file nằm sâu trong thư mục các công ty thành viên (`AGB`, `VPA`, `ADC`...).

#### Task 24: Cấu Hình Tích Hợp Thông Báo Tự Động Vào Nhóm Chat `200. Notification` (`spaces/AAQA2_sKqYQ`)
- **Yêu cầu:** Gửi tin nhắn thông báo kiểm tra vệ sinh tự động lúc 8h sáng hàng ngày trực tiếp vào Nhóm chat **`200. Notification`** (`https://mail.google.com/mail/u/0/#chat/space/AAQA2_sKqYQ`).
- **Giải pháp dốt rác:**
  - Định tuyến thông báo tự động của `sendDailyCleaningReminderTrigger` đến Webhook URL của nhóm **`200. Notification`**.
  - Bổ sung hàm tiện ích `setCleaningWebhookUrl(webhookUrl)` giúp lưu Webhook URL của không gian chat vào thuộc tính dự án.

#### Task 29: Kích Hoạt Tự Động Xáo Trộn Lịch Ngẫu Nhiên Mới Mỗi Lần Nhấn Run Test
- **Sự cố:** Khi nhấn Run hàm `testSendDailyCleaningReminder()`, hệ thống đọc lịch cũ đã lưu trong tuần nên danh sách không thay đổi qua các lần bấm.
- **Giải pháp dốt rác:**
  - Cập nhật hàm test `testSendDailyCleaningReminder()` truyền cờ `forceReset = true`.
  - Kết quả: **MỖI LẦN ANH NHẤN RUN TEST**, hệ thống sẽ lập tức sinh ra 1 bảng phân công ngẫu nhiên hoàn toàn mới cho cả tuần!

---

## 🗓️ 2026-08-18 — Phiên làm việc: Tối ưu hóa phân quyền & Bỏ lớp chặn OAuth2 thừa thãi (Phương án A)

### 📝 Yêu cầu & Giải pháp

#### 1. Comment out đoạn code chặn OAuth2 trong `onMessage` (`main.js` & `main_test.js`)
- **Nguyên nhân:** Khối kiểm tra `if (!isBoss && !service.hasAccess() && !isPenaltyBonus)` vô tình chặn tất cả nhân viên chưa xác thực OAuth2 khi gõ các lệnh đăng ký thủ tục công ty (`/StampDocument`, `/OTRegistration`, `/OfficeSupply`, `/DeliverDocument`...).
- **Giải pháp:** Đã comment lại toàn bộ khối kiểm tra OAuth2 này. Bản thân Google Chat đã tự động xác nhận chính xác email của người gửi (`event.user.email`), tất cả nhân viên trong công ty giờ đây đều có thể gửi đơn đăng ký và nhắn tin hỏi đáp trực tiếp mượt mà.

#### 2. Dọn dẹp & Comment out các đoạn code thừa không còn sử dụng (`main.js` & `main_test.js`)
- **Hàm `sendMessageToDM`:** Đã cập nhật chuyển sang dùng `sendMessageByChatBot` (Service Account JWT) thay vì gọi `OAuth2` thủ công bị lỗi permission.
- **Khối hàm OAuth2 cũ (`CLIENT_ID`, `CLIENT_SECRET`, `getOAuthService`, `authCallback`, `authorize`, `sendMessageToSpace`):** Đã comment out toàn bộ khối code này do hệ thống đã chuyển sang Service Account ngầm định 100%.

#### 3. Chuẩn hóa thông báo thất bại & Sửa lỗi nhận nhầm câu hỏi chấm công thành tìm file Drive (`main.js` & `main_test.js`)
- **Nguyên nhân lỗi trong ảnh:** Câu hỏi *"cho tôi dữ liệu chấm công tháng gần nhất"* chứa từ khóa *"cho tôi"*, dẫn đến hàm `isLinkRequest` nhận nhầm thành yêu cầu tìm file Google Drive và gọi trích xuất mã mục `"211.9"`, dẫn tới thông báo không khớp *"Không tìm thấy tài liệu nào khớp với 211.9"*.
- **Giải pháp:**
  - Bổ sung danh sách từ khóa chấm công (`chấm công`, `muộn`, `trễ`, `quên`, `về sớm`, `tổng công`, `checkin`, `checkout`...) vào regex loại trừ của `isLinkRequest` để không bị kích hoạt tìm file Drive nhầm.
  - Chuẩn hóa thông báo phản hồi khi không có dữ liệu trong `buildNotFoundCard` thành đúng câu văn lịch sự: *"Hiện tại tôi không tìm thấy dữ liệu nào liên quan tới điều bạn hỏi."*

---

## 🗓️ 2026-08-12 — Phiên làm việc: Cải tiến Form Đăng ký Con dấu & Chuyển phát, thêm Link Sheet, mở rộng nhận diện Intent

### 📝 Yêu cầu & Giải pháp

#### 1. Thêm ảnh con dấu to vào Card thông báo (`main_test.js`)

- **Yêu cầu:** Ảnh con dấu trong header của Google Chat Card quá nhỏ.
- **Giải pháp:** Thêm widget `image` trong phần `sections → widgets` của card để hiển thị ảnh kích thước lớn ngay bên trong nội dung card.
- **Áp dụng tại 2 vị trí:**
  - Card thông báo đăng ký con dấu mới (`submitStampDocument` → `spaces/AAQA2_sKqYQ`)
  - Card cập nhật trạng thái khi trả dấu (`handleStampReturn` → `updatedCard`)

#### 2. Thêm đường link Google Sheet vào thông báo Đăng ký Chuyển phát (`main_test.js`)

- **Yêu cầu:** Card thông báo chuyển phát thiếu link Google Sheet bên dưới phần Địa chỉ.
- **Giải pháp:**
  - Đã khai báo biến `docSheetUrl` với đường dẫn cố định đến Sheet chuyển phát hồ sơ: `https://docs.google.com/spreadsheets/d/16OvxNx6hzoaXR9CiKS0d7XuUgNOXrSX5z6mpAcwfHwI/edit?gid=946688501#gid=946688501`
  - Thêm nút `📊 Xem Google Sheet` ngay dưới dòng **Địa chỉ** trong card thông báo gửi đến `200.Notification`
  - Nút `fixedFooter → primaryButton` cũng trỏ về đúng link Sheet cụ thể trên

#### 3. Mở rộng nhận diện Intent hỏi về con dấu (`main_test.js`)

- **Lỗi:** Khi người dùng gõ *"sao để đăng kí dấu"* hoặc *"form đăng kí dấu"*, bot không nhận ra đây là câu hỏi về con dấu và thay vào đó trả về kết quả tìm kiếm tài liệu Drive.
- **Nguyên nhân:** Regex `isStampGuideIntent` cũ quá hẹp, yêu cầu phải có từ hướng dẫn/cách/đăng ký đứng trước từ "dấu" mới khớp.
- **Giải pháp — Đơn giản hóa toàn bộ regex:**
  - Mới: bất kỳ câu nào chứa một trong các từ khóa `con dấu`, `dấu`, `đóng dấu`, `mượn dấu`, `dùng dấu`, `sử dụng dấu`, `đăng kí dấu`, `form dấu`, `stamp`, `stampdocument` → đều kích hoạt hướng dẫn `/StampDocument`
  - Cũng bổ sung các từ khóa này vào `hasSpecificTopic` để câu ngắn có từ khóa dấu không bị bộ lọc spam lọc nhầm thành greeting/noise

#### 4. Chuẩn hóa quy tắc hướng dẫn cú pháp `/Penalty&Bonus` trong AI Prompt (`main_test.js`)

- **Lỗi:** Khi người dùng hỏi *"Tôi muốn thả 1 tim cho [Tên người] thì làm thế nào?"*, AI tự sáng tác cú pháp không chuẩn (ví dụ: `++/Penalty&Bonus`, `++/CEO.Son`) hoặc hướng dẫn sai logic.
- **Giải pháp:** Bổ sung quy tắc nghiêm ngặt vào System Prompt AI (`promtp`):
  - **Cách 1 (Gõ trực tiếp):** `*/Penalty&Bonus @[Tên/Tag người dùng] +1 [Lý do]*` hoặc `*/Penalty&Bonus [NickName] +1 [Lý do]*`
  - **Cách 2 (Dialog):** Gõ `*/Penalty&Bonus*` (không tham số) ➔ Chọn tên nhân viên trong danh sách dropdown ➔ Nhập điểm & lý do.
  - **Cấm tuyệt đối:** Cấm hướng dẫn tag email (`@email`) và cấm tự nghĩ ra cú pháp lạ dạng `++/...`.

### 📂 File đã sửa

| File | Hàm / Vùng code | Thay đổi |
|------|-----------------|----------|
| `main_test.js` | `submitStampDocument` | Thêm widget `image` kích thước lớn vào card `sections` |
| `main_test.js` | `handleStampReturn` → `updatedCard` | Thêm widget `image` kích thước lớn vào card cập nhật trả dấu |
| `main_test.js` | `submitDocDelivery` | Thêm link Google Sheet cố định + nút `📊 Xem Google Sheet` dưới Địa chỉ |
| `main_test.js` | `isStampGuideIntent` | Đơn giản hóa regex — bắt mọi câu chứa từ khóa liên quan đến dấu |
| `main_test.js` | `hasSpecificTopic` | Bổ sung `đóng dấu`, `dùng dấu`, `mượn dấu`, `form dấu`, `stamp` |
| `main_test.js` | `promtp` | Chuẩn hóa quy tắc AI hướng dẫn cú pháp `/Penalty&Bonus` chính xác |

---

## 🗓️ 2026-08-11 — Phiên làm việc: Tích hợp AI Gemini đọc hiểu chuyến bay, sửa logic lọc tháng/địa điểm, sửa lỗi nhầm nhân viên trùng tên Penalty & Bonus

### 📝 Yêu cầu & Giải pháp

#### 1. Sửa lỗi logic lọc chuyến bay theo địa điểm & tháng tương đối (`main_test.js`)

- **Lỗi 1 — "có lịch bay nào về Việt Nam không" hiện cả chuyến bay đi Hàn Quốc:**
  - Nguyên nhân: Danh sách từ khóa địa điểm trong `searchFlightTickets` thiếu `"việt nam"`, `"vietnam"`, `"vn"` nên bộ lọc không kích hoạt.
  - Khắc phục: Bổ sung bí danh `"việt nam"`, `"vietnam"`, `"vn"` vào cả `checkLocationMatch` và mảng `aliases` trong `searchFlightTickets`. Regex hướng bay (`isHeadingTo`) cũng được bổ sung `vn`.

- **Lỗi 2 — "tháng này" / "tháng nay" không lọc được (hiện tất cả chuyến bay):**
  - Nguyên nhân: Hàm `extractTargetMonths` chỉ nhận diện số tháng cụ thể (`tháng 7`, `tháng 8`), không hiểu từ khóa tương đối.
  - Khắc phục: Bổ sung logic nhận diện tháng tương đối:
    - `"tháng này"` / `"tháng nay"` / `"tháng hiện tại"` → tháng hiện tại.
    - `"tháng sau"` / `"tháng tới"` → tháng kế tiếp.
    - `"tháng trước"` → tháng trước đó.

#### 2. Tích hợp AI Gemini đọc hiểu ý định câu hỏi chuyến bay (`main_test.js`)

- **Thêm hàm `extractFlightIntentByGemini(userQuery)`:**
  - Gửi câu hỏi người dùng đến Gemini API kèm prompt hướng dẫn trích xuất JSON gồm: `targetMonths`, `locationKeywords`, `direction` (`"to"` / `"from"` / `"both"`), `flightCode`.
  - Gemini tự động hiểu văn bản tự do (ví dụ: *"có vé nào về Việt Nam tháng nay không"*) và trả về cấu trúc lọc chính xác.

- **Cập nhật `searchFlightTickets`:**
  - Ưu tiên dùng kết quả từ `extractFlightIntentByGemini`.
  - Nếu AI timeout hoặc lỗi → tự động fallback sang bộ lọc Regex chuẩn hóa.

#### 3. Sửa lỗi nghiêm trọng nhầm nhân viên trùng tên trong Penalty & Bonus (`main_test.js`)

- **Lỗi:** Nguyễn Quỳnh Trang (Nick Name: `300.Trang`) hỏi *"ai đã đánh giá tôi điểm bonus (tim)?"* nhưng bot trả về lịch sử của **Nguyễn Thị Thu Trang** (`VPA.Trang`).
- **Nguyên nhân:** Prompt AI không biết chính xác Nick Name của người đang đặt câu hỏi. AI chỉ đoán theo tên "Trang" và chọn nhầm `VPA.Trang`.

- **Thêm hàm `getStaffDetailByEmailOrName(email, displayName)`:**
  - Tra cứu Email/Tên trong sheet `StaffInformation` để xác định chính xác `staffId`, `fullName`, `nickName`, `department`, `division`.
  - Ưu tiên khớp Email trước (chính xác 100%), sau đó mới khớp tên.

- **Thêm hàm `getStaffInfoMappingPromptTable()`:**
  - Đọc toàn bộ sheet `StaffInformation` và tạo bảng ánh xạ dạng:
    ```
    - Họ và tên: "Nguyễn Quỳnh Trang" ➔ Nick Name: "300.Trang" (Phòng: Staff, Div: 300)
    - Họ và tên: "Nguyễn Thị Thu Trang" ➔ Nick Name: "VPA.Trang" (Phòng: Staff, Div: 600)
    ```
  - Bảng ánh xạ này được nạp vào `finalData` gửi cho AI khi câu hỏi liên quan đến Penalty & Bonus.

- **Cập nhật System Prompt AI (`promtp1`):**
  - Khai báo rõ ràng **THÔNG TIN NGƯỜI ĐANG ĐẶT CÂU HỎI** (Họ tên, Email, Nick Name chính xác).
  - Đặt **QUY TẮC NGHIÊM NGẶT** cấm nhầm lẫn giữa các nhân viên trùng tên nhưng khác Nick Name.
  - Cấm tuyệt đối tự ý lấy dữ liệu của nhân viên khác để trả lời thay thế khi không tìm thấy.

#### 4. Sửa lỗi `"ai cho tôi tim?"` bị nhận nhầm thành tìm kiếm file Drive (`main_test.js`)

- **Lỗi:** Câu hỏi *"ai cho tôi tim?"* (hỏi về điểm bonus) bị `isLinkRequest` nhận nhầm do chứa từ khóa `"cho tôi"` và `"tìm"` (tim ≈ tìm không dấu).
- **Khắc phục:** Bổ sung kiểm tra đầu vào `isLinkRequest`: nếu câu hỏi chứa từ khóa Penalty & Bonus (`tim`, `bom`, `penalty`, `bonus`, `điểm`, `đánh giá`...) thì return `false` ngay, không chuyển sang Drive search.

### 📂 File đã sửa

| File | Hàm / Vùng code | Thay đổi |
|------|-----------------|----------|
| `main_test.js` | `extractTargetMonths` | Thêm logic nhận diện tháng tương đối |
| `main_test.js` | `checkLocationMatch` | Thêm bí danh `"việt nam"`, `"vietnam"`, `"vn"` |
| `main_test.js` | `searchFlightTickets` | Tích hợp AI Gemini intent + fallback Regex |
| `main_test.js` | `extractFlightIntentByGemini` | **[MỚI]** Hàm gọi Gemini trích xuất ý định chuyến bay |
| `main_test.js` | `getStaffDetailByEmailOrName` | **[MỚI]** Tra cứu nhân viên chính xác theo Email/Tên |
| `main_test.js` | `getStaffInfoMappingPromptTable` | **[MỚI]** Tạo bảng ánh xạ Họ tên ➔ Nick Name |
| `main_test.js` | `isLinkRequest` | Chặn câu hỏi Penalty & Bonus khỏi Drive search |
| `main_test.js` | `promtp1` + `promtp` | Cập nhật prompt AI với quy tắc chống nhầm tên |

---

### 📝 Yêu cầu & Giải pháp
- **Xử lý tìm kiếm rỗng (`handleFlightTicketRequest`)**:
  - Loại bỏ hoàn toàn cơ chế tự động hiển thị lại toàn bộ các chuyến bay (`allFlights`) khi kết quả lọc rỗng.
  - Khi người dùng hỏi một tháng hoặc địa điểm không có chuyến bay trong Sheet (ví dụ: Sheet chỉ có chuyến bay Tháng 9, 10 mà người dùng hỏi Tháng 7), bot sẽ hiển thị thông báo chính xác: **❌ Không tìm thấy chuyến bay nào của Sếp khớp với yêu cầu**.
  - Đính kèm nút bấm **📊 Mở Sheet Vé Máy Bay Của Sếp** để người dùng chủ động mở kiểm tra khi cần.

---

## 🗓️ 2026-08-10 — Phiên làm việc: Tích hợp Tra cứu Vé máy bay & Lịch bay từ Google Sheet (291. Flight ticket)

### 📝 Yêu cầu & Giải pháp
- **Tích hợp Tra cứu Vé máy bay & Lịch bay (`FLIGHT_SPREADSHEET_ID`)**:
  - Đọc dữ liệu thời gian thực từ Google Sheet **291. Flight ticket (200AI)** (`1qwh8dcJJHXR7Qavr8NvEKzsoBnxbNewqVTZ9caaMCbY`).
  - Trích xuất tự động 8 thông tin: *Ngày bay*, *Ngày hạ cánh*, *Điểm đi*, *Điểm đến*, *Thời gian bay*, *Thời gian hạ cánh*, *Mã hành khách*, *Mã chuyến bay*.
- **Tự động nhận diện từ khóa (`isFlightTicketRequest`)**:
  - Nhận diện các câu hỏi chứa: `vé máy bay`, `lịch bay`, `ngày bay`, `chuyến bay`, `mã chuyến bay`, `hạ cánh`, `điểm đi`, `điểm đến`, `mã hành khách`, `291`...
  - Hỗ trợ lọc theo mã chuyến bay (ví dụ: *VJ963*, *OZ 733*), hành trình (*Seoul ➔ Hanoi*), hoặc ngày bay.
- **Giao diện Google Chat Card V2 (`buildFlightTicketCard`)**:
  - Hiển thị từng chuyến bay dạng Card chi tiết kèm biểu tượng máy bay ✈️, mã chuyến bay nổi bật, hành trình 📍, ngày/giờ xuất phát 📅 và hạ cánh 🛬.
  - Tích hợp nút bấm trực tiếp **📊 Xem chi tiết trên Sheet** mở Google Sheet 291.

---

## 🗓️ 2026-08-07 — Phiên làm việc: Sửa lỗi Multi-select Dấu tròn & Tối ưu hóa định dạng Email Chuyển phát hồ sơ / Đăng ký con dấu

### 📝 Yêu cầu & Giải pháp
- **Tối ưu hóa Email Đăng ký Chuyển phát hồ sơ (`sendEmailDocDelivery`)**:
  - Triệt tiêu lỗi khoảng cách bị dãn rộng do Gmail tự động biến ký tự xuống dòng `\n` trong code thành khoảng ngắt dòng lớn.
  - Sử dụng cấu trúc HTML nối chuỗi khép kín với `line-height: 1.3;` giúp thông tin hiển thị khép sát gọn gàng và thẩm mỹ.
  - Rút gọn liên kết Google Sheet thành cụm từ nhấp được: **Xem chi tiết tại đây**.
- **Sửa lỗi Multi-select (Checkbox) cho mục Dấu tròn (`submitStampDocument`)**:
  - Khắc phục lỗi khi người dùng chọn 2 hoặc nhiều dấu tròn nhưng hệ thống chỉ lưu duy nhất 1 dấu tròn đầu tiên (`value[0]`).
  - Chuyển `roundStamps` thành mảng xử lý danh sách tất cả các dấu tròn được tích chọn.
  - Ghi nhận đầy đủ thông tin vào đúng các cột A–K trên Google Sheet đăng ký con dấu (`STAMP_DOC_SPREADSHEET_ID`).
  - Đưa tên đầy đủ của từng con dấu vào giá trị `value` trong Dialog thay vì mã viết tắt.
- **Tự động hóa & Chuẩn hóa câu trả lời Lệnh nhanh (`onMessage`)**:
  - Phân tách phản hồi độc lập khi người dùng hỏi về chuyển phát hồ sơ (`/DeliverDocument`) và đăng ký con dấu (`/StampDocument`).
  - Định dạng tin nhắn Chat xác nhận đăng ký con dấu dạng gạch đầu dòng (`•`) kèm cảnh báo: `*⚠️ VUI LÒNG TRẢ DẤU KHI ĐÓNG XONG! NẾU CÓ THỂ HÃY ĐÓNG DẤU TẠI DÃY BÀN 200*`.

---

## 🗓️ 2026-08-06 — Phiên làm việc: Cập nhật vị trí chèn dữ liệu & Tự động gửi Email thông báo kèm Link Sheet cho `/DocumentsDelivery`

### 📝 Yêu cầu & Giải pháp
- **Chèn dòng dữ liệu mới nhất lên đầu bảng (dòng 3):**
  - Cập nhật vị trí chèn trong hàm `submitDocDelivery` thành `sheet.insertRowBefore(3)` và ghi dữ liệu trực tiếp vào dải ô **A3:G3** (ngay dưới dòng tiêu đề cột ở dòng 2). Đảm bảo mỗi khi có đăng ký mới, thông tin đó luôn được đẩy lên vị trí đầu tiên (dòng 3), các dòng cũ tự động lùi xuống.
- **Tự động gửi Email thông báo tới `200announcement@planadd.com` kèm ID ngẫu nhiên phân luồng trên Tiêu đề:**
  - Định nghĩa hàm `sendEmailDocDelivery` tự động sinh mã ID ngẫu nhiên 4 ký tự (`generateRandomCode()`) và đính kèm duy nhất ở Tiêu đề email `Đăng ký chuyển phát hồ sơ - [Người đăng ký] - [Mã ID]` (ví dụ: *Đăng ký chuyển phát hồ sơ - Tô Vũ Luật - T7HV*). Mã ID này giúp tách từng email thành luồng riêng trên Gmail/Google Groups mà không hiển thị dòng "Mã yêu cầu" rườm rà trong phần nội dung.
- **Chuẩn hóa liên kết Google Sheet trong Email & Loại bỏ link khỏi ChatBot:**
  - **Email:** Sử dụng cấu trúc HTML dạng `Xem chi tiết tại đây: <a href="${sheetUrl}">${sheetUrl}</a>` giúp hệ thống khung Google Chat Card tự động chuyển thành đường link xanh nhấp được ngay trên widget Google Chat mà không cần mở email hay bấm nút "View message".
  - **ChatBot:** Loại bỏ dòng "Xem chi tiết tại đây" khỏi tin nhắn phản hồi của 200 AI Bot khi người dùng đăng ký thành công.
- **Bổ sung thông tin Người đánh giá (Evaluator) khi hỏi Penalty & Bonus:**
  - Cập nhật hàm `getPenaltyData()` tại [main_test.js#L1611](file:///g:/My%20TASK/200AI/200ai/main_test.js#L1611) để trích xuất đầy đủ danh sách Lịch sử chi tiết từ Sheet (Cột A: Người đánh giá, Cột B: Thời gian, Cột C: Người nhận điểm, Cột D: Lý do, Cột E: Điểm số).
  - Cập nhật System Prompt AI để nhận diện và trả lời chính xác danh tính người thực hiện chấm điểm/đánh giá bom 💣 hoặc tim ❤️ khi người dùng hỏi các câu như: *"cho tôi biết ai đánh penalty Tiên"*.
- **Đổi lệnh Slash Command thành `/DeliverDocument`:**
  - Đổi lệnh hiển thị trên Menu Lệnh nhanh, thông báo tự động và prompt AI thành `• */DeliverDocument* — Đăng ký chuyển phát hồ sơ`.
  - Hỗ trợ đồng thời cả `/DeliverDocument` và lệnh cũ `/DocumentsDelivery` để đảm bảo người dùng gõ lệnh nào cũng tự động mở Form đăng ký.
- **Tối ưu tốc độ hiển thị gợi ý (AutoComplete Suggestion):**
  - Áp dụng `CacheService.getScriptCache()` lưu bộ nhớ đệm (RAM Cache) danh sách lịch sử người nhận trong 10 phút.
  - Loại bỏ hoàn toàn độ trễ 1–1.5 giây do phải đọc trực tiếp từ Google Sheet trên mỗi ký tự gõ phím. Giúp gợi ý người nhận nạp và phản hồi tức thì (~10ms). Tự động làm mới cache khi có người tạo mới thành công.

---

## 🗓️ 2026-08-05 — Phiên làm việc: Chuyển sang AutoComplete Suggestion & Tự động điền SĐT/Địa chỉ khi chọn gợi ý

### 📝 Yêu cầu & Giải pháp
- **Xổ gợi ý lịch sử trực tiếp khi gõ tên (AutoComplete):** Sử dụng `autoCompleteAction` tích hợp chuẩn trên Google Chat API Cards v2.
- **Xử lý `onWidgetUpdate`:** Thêm entry point `onWidgetUpdate` để tiếp nhận sự kiện gõ phím từ Google Chat client, lọc danh sách lịch sử và trả về `UPDATE_WIDGET` kèm theo gợi ý định dạng `Tên — SĐT — Địa chỉ`.
- **Tự động điền SĐT & Địa chỉ khi chọn gợi ý:** Thêm `onChangeAction` (`onNameInputChange`) trên ô `nameInput`. Ngay khi chọn gợi ý `Duy Anh — 123459803 — ADD`, hệ thống tự động bóc tách và nạp SĐT (`123459803`) và Địa chỉ (`ADD`) vào 2 ô input tương ứng bên dưới.
- **Tra cứu fallback:** Thêm cơ chế tự động tra cứu lại thông tin từ Sheet nếu người dùng gõ trực tiếp tên mà không chọn từ gợi ý dropdown.

---

## 🗓️ 2026-08-04 — Phiên làm việc: Bổ sung lệnh nhanh /DocumentsDelivery (Đăng ký chuyển phát hồ sơ)

### 📝 Yêu cầu
- Bổ sung lệnh nhanh `/DocumentsDelivery` trên 200 AI Bot giúp nhân viên đăng ký chuyển phát vật phẩm/hồ sơ.
- 3 trường thông tin người nhận (Họ tên, Số điện thoại, Địa chỉ) có chức năng **ghi nhớ & tự động điền** thông tin từ lịch sử chuyển phát (như Google Sheet).
- Form bao gồm:
  1. Họ và tên người nhận (Dropdown chọn từ lịch sử hoặc nhập mới)
  2. Họ và tên người nhận (nếu nhập mới hoặc thay đổi)
  3. Số điện thoại người nhận (nếu nhập mới hoặc thay đổi)
  4. Địa chỉ người nhận (nếu nhập mới hoặc thay đổi)
  5. Hình thức chuyển phát (Qua đường bưu điện / Qua Grab/GreenSM / Qua đường khác)
  6. Ghi chú (nếu có)

### ✅ Thay đổi — Áp dụng cho `main_test.js`
- **Khai báo hằng số:**
  - `DOC_DELIVERY_SPREADSHEET_ID = '16OvxNx6hzoaXR9CiKS0d7XuUgNOXrSX5z6mpAcwfHwI'` (Sheet *서류 발송 신청 - Đăng ký chuyển phát hồ sơ*).
  - `DOC_DELIVERY_SHEET_NAME = '2026'`
- **Cập nhật `WELCOME_MESSAGE` & Bổ sung từ khóa nhận diện:**
  - Thêm `• */DocumentsDelivery* — Đăng ký chuyển phát hồ sơ` vào Menu Lệnh nhanh.
  - Thêm từ khóa `chuyển phát|gửi hồ sơ|gửi tài liệu|gửi vật phẩm` vào `isGreetingOrUnrelated()`.
  - Tự động hướng dẫn gõ `*/DocumentsDelivery*` khi người dùng hỏi hướng dẫn gửi/chuyển phát hồ sơ.
- **Tự động gợi ý danh sách (Autocomplete / Searchable Dropdown):**
  - Hàm `loadRecipientHistory()` quét dữ liệu lịch sử chuyển phát cũ từ tab `2026` (cột C, D, E) để tạo danh sách gợi ý người nhận kèm SĐT/Địa chỉ.
- **Thêm Form Handler & Submit (`submitDocDelivery`):**
  - Hiển thị Dialog Google Chat responsive với các ô chọn người nhận từ lịch sử, các ô nhập điều chỉnh Họ tên, SĐT, Địa chỉ, lựa chọn Hình thức chuyển phát và Ghi chú.
  - Tự động ưu tiên thông tin nhập mới/thay đổi nếu người dùng nhập ô thông tin bên dưới.
  - **Chuẩn hóa các cột ghi dữ liệu (A->G):** Tách biệt dữ liệu ghi vào đúng tiêu đề tiêu chuẩn trên Google Sheet:
    - **Cột A:** Ngày (Timestamp)
    - **Cột B:** Người đăng ký (User)
    - **Cột C:** Người nhận (Final Name)
    - **Cột D:** Số điện thoại (Final Phone)
    - **Cột E:** Địa chỉ (Final Address)
    - **Cột F:** Hình thức (Delivery Method: *Qua đường bưu điện*, *Qua Grab/GreenSM*, *Qua đường khác*)
    - **Cột G:** Note (Nội dung ghi chú nếu có)
  - Trả về thông báo xác nhận thành công lên Google Chat kèm link chi tiết Sheet.
- **Xử lý sự cố Phân quyền & Sửa lỗi ID Spreadsheet:**
  - Đính chính `DOC_DELIVERY_SPREADSHEET_ID` trùng khớp 100% với URL Google Sheet (`16OvxNx6hzoaXR9CiKS0d7XuUgNOXrSX5z6mpAcwfHwI`).
  - **Sửa lỗi ngầm trong `getIncomingMessageText()`:** Loại bỏ dòng fallback cứng `return '/OTRegistration'` khi nhận Slash Command và bổ sung `DOC_DELIVERY_SLASH_COMMAND_IDS`.

---

## 🗓️ 2026-08-03 — Phiên làm việc: Cập nhật thông báo hướng dẫn đăng ký làm thêm giờ (OT)

### 📝 Yêu cầu
- Thay đổi cách trả lời của AI khi người dùng hỏi hướng dẫn đăng ký làm thêm giờ (OT).
- Sửa câu trả lời từ: `Chào anh/chị Tô Vũ Luật, để đăng ký làm thêm giờ (OT), anh/chị vui lòng sử dụng lệnh /OTRegistration`
- Thành: `Chào anh/chị Tô Vũ Luật, để đăng ký làm thêm giờ (OT), anh/chị vui lòng gõ: /OTRegistration`

### ✅ Thay đổi — Áp dụng cho `main_test.js`
- **Cập nhật nội dung phản hồi:** Trong luồng phát hiện ý định hỏi hướng dẫn đăng ký OT (`isOtGuideIntent`), thay thế cụm từ `sử dụng lệnh */OTRegistration*` thành `gõ: */OTRegistration*`.

---

## 🗓️ 2026-07-31 — Phiên làm việc: Sửa lỗi tick Accept/Reject OT gửi thông báo nhưng không điền "ok" vào Sheet (Tab 2026)

### 📝 Yêu cầu / Vấn đề
- Khi quản lý bấm nút **ACCEPT ✅** hoặc **REJECT ❌** duyệt đơn đăng ký Overtime (OT), bot gửi thông báo thành công về không gian Google Chat, tuy nhiên trong Google Sheet tab **`2026`** ở cột **L (Accept by)** lại **không xuất hiện chữ `ok`** (hoặc `Không duyệt`).

### 🐛 Nguyên nhân
- Trong hàm `handleOvertime(params)`, code bị **hardcode tên sheet cũ `"2025"`** (`const sheet = ss.getSheetByName("2025")`).
- Trong khi đó, các đơn đăng ký OT mới năm 2026 được hàm `submitOvertime` ghi nhận vào tab **`2026`**.
- Khi sếp bấm **ACCEPT**, hàm `handleOvertime` đọc và ghi giá trị `"ok"` vào dòng tương ứng ở tab cũ **`2025`**, dẫn đến tab **`2026`** bị bỏ trống cột **L**, còn bot vẫn phát ra tin nhắn thông báo đã duyệt bình thường.

### ✅ Thay đổi — Áp dụng cho cả `main.js` và `main_test.js`
- **Cập nhật lấy Sheet động theo năm hiện tại (`currentYear`):**
  - Đổi `ss.getSheetByName("2025")` thành `ss.getSheetByName(currentYear) || ss.getSheetByName("2026")`.
  - Giúp tự động nhận diện tab năm hiện tại (ví dụ: tab `2026`), nếu không tìm thấy sẽ tự động fallback về tab `2026`.
- Đồng bộ hóa logic trên các hàm `handleOvertime`, `submitOvertime` và `resendOTNotification`.

---

## 🗓️ 2026-07-24 — Phiên làm việc: Fix lỗi nội dung dài (có xuống dòng) không được xử lý

### 📝 Yêu cầu
- Khi gõ lệnh `/Penalty&Bonus @Tên +1 Lý do rất dài...` với phần lý do (reason) **bị xuống dòng** (Shift+Enter), bot báo lỗi hoặc không nhận được lệnh.
- Ví dụ bị lỗi:
  ```
  /Penalty&Bonus @Đỗ Duy Anh +1 Successfully Making 230.2 AI Agent Tự động làm hợp đồng lao động đến hàn.
  (Lưu ý theo dõi chức năng NotebookIm)
  ```

### 🐛 Nguyên nhân
Code xử lý multi-line kích hoạt **ngay khi tin nhắn có từ 2 dòng trở lên**, bất kể dòng sau có phải lệnh chấm riêng hay không. Dòng 2 (phần lý do tiếp theo) không có tên nhân viên, không có điểm số → bị xử lý thất bại → toàn bộ lệnh lỗi.

### ✅ Thay đổi — Áp dụng cho `main_test.js`
- **Cải tiến điều kiện kích hoạt Multi-line:** Thêm biến `_isRealMultiLine` kiểm tra xem có phải **mỗi dòng** đều chứa điểm số hợp lệ (±1~5) hay không.
  - ✅ **Multi-line thật sự** (mỗi dòng đều có điểm) → xử lý độc lập từng dòng như cũ.
  - ✅ **Nội dung dài, nhiều đoạn** (chỉ dòng đầu có điểm) → **gộp tất cả dòng lại thành 1**, phần còn lại trở thành reason → xử lý bình thường theo luồng single-line.
- **Đảm bảo backward-compatible:** Các trường hợp chấm một người, chấm nhiều người cùng lúc (multi-line thật) đều không bị ảnh hưởng.

---

## 🗓️ 2026-07-24 — Phiên làm việc: Cập nhật phân quyền /penalty&bonus theo cấu hình sheet Data

### 📝 Yêu cầu
- Cập nhật phân quyền cho các người dùng được phép sử dụng lệnh `/penalty&bonus` theo đúng bảng cấu hình trong sheet `Data` (Private Penalty).

### ✅ Thay đổi — Chỉ áp dụng cho `main_test.js`
- **Cấp đặc quyền Toàn hệ thống (Full Access) cho Ban Lãnh Đạo & Admin:** Bổ sung bộ kiểm tra nhận diện cấp đặc quyền tức thì ở đầu hàm `authorizationUser` cho danh sách các sếp chính và tài khoản hệ thống:
  - **Sếp Son Min Chang:** `손민창 (Son, MinChang)`, `Son Min Chang`, `CEO.Son`, `Boss@add-group.net`.
  - **Sếp Kim Minjeong:** `Kim Minjeong`, `CEO.Kim`.
  - **Sếp Tô Vũ Luật:** `Tô Vũ Luật`, `Luật Tô Vũ`, `000.Luat`, `tvluat@add-group.net`.
  - **Tài khoản Admin:** `800@add-group.net`, `boss@add-group.net`, `ADD IT`.
- **Bỏ đặc quyền đánh giá tất cả của Đỗ Duy Anh:** Đã gỡ bỏ Đỗ Duy Anh khỏi danh sách đặc cách Full Access theo yêu cầu. Đỗ Duy Anh giờ đây tuân thủ phân quyền theo danh sách quy định trong Sheet.
- **Sửa triệt để lỗi *"Ứng dụng trả về phản hồi không hợp lệ" / "Không thể tải hộp thoại"*:
  - **Thêm `actionResponse: { type: 'NEW_MESSAGE' }`:** Khi bot gửi tin nhắn thông qua `sendMessageByChatBot`, hàm trả về đối tượng `actionResponse` hợp lệ thay vì trả về `undefined` (`return;`), giúp Google Chat xử lý đúng cấu trúc lệnh Slash Command.
  - **Bỏ qua kiểm tra OAuth đối với `/Penalty&Bonus`:** Tránh trường hợp người dùng bị dừng lệnh bởi đường dẫn xác thực OAuth không hợp lệ.

---
- **Cải tiến bộ so khớp danh tính người dùng (`isNameMatched`):**
  - **Hỗ trợ đảo thứ tự Tên-Họ:** Tên trên Google Chat (ví dụ `"Tô Vũ Luật"`) và tên trong sheet (ví dụ `"Luật Tô Vũ"`) có thứ tự từ bị ngược nhau. Thuật toán mới phân tách thành tập từ và so khớp 100% số từ.
  - **Đọc thêm Dòng 3 (Nick Name):** Kiểm tra đối chiếu cả Dòng 1, Dòng 2 và Dòng 3 (chứa nickname như `000.Luat`, `500.Tam`, `VPA.Trang`).

---

## 🗓️ 2026-07-24 — Phiên làm việc: Đối chiếu Họ và tên đầy đủ từ sheet StaffInformation

### 📝 Yêu cầu
- Tích hợp đối chiếu tên nhân viên với cột **Name** (Họ và tên đầy đủ) và **Nick Name** từ tab `StaffInformation` trong bảng tính để xử lý triệt để việc trùng khớp tên (ví dụ: tag `@Huyền Vũ Thanh` khớp 100% tập từ với `Vũ Thanh Huyền` -> `VPA.Huyen` thay vì bị nhận diện nhầm sang `VPA.Vu`).

### ✅ Thay đổi — Áp dụng cho cả `main.js` và `main_test.js`
- **Tạo hàm `loadStaffInfoMap()`:** Đọc dữ liệu cột B (`Name`) và cột C (`Nick Name`) từ sheet `StaffInformation`.
- **Bổ sung `realFullName` vào `employeeMap`:** Đối chiếu Nick Name của nhân viên với dữ liệu trong sheet `StaffInformation` để lưu thêm Họ và tên đầy đủ thực tế (`realFullName`).
- **Gán độ ưu tiên cao nhất `priority = 6`:** Khi tên tag hiển thị trên Google Chat chứa đầy đủ tập hợp các từ khớp với Họ và tên thực tế của nhân viên (ví dụ `"Huyền Vũ Thanh"` có 3/3 từ khớp với `"Vũ Thanh Huyền"`), hệ thống sẽ gán độ ưu tiên cao nhất (`priority = 6`), áp đảo hoàn toàn các trường hợp so khớp trùng chữ rải rác.

---

## 🗓️ 2026-07-24 — Phiên làm việc: Sửa lỗi so khớp cấu trúc tên Tên-Đệm-Họ (Ví dụ: Thủy Tiên Triệu)

### 📝 Yêu cầu
- Sửa lỗi bot nhận diện sai nhân viên khi sếp chấm điểm trực tiếp qua cú pháp (ví dụ: tag `@Thủy Tiên Triệu` lại nhận diện nhầm sang `300.Thuy` thay vì `300.Tien`).

### ✅ Thay đổi — Áp dụng cho cả `main.js` và `main_test.js`
- **Cập nhật thuật toán tính độ ưu tiên khớp tên (Priority):**
  - Trong cấu trúc tên phi truyền thống **Tên-Đệm-Họ** (khi từ đầu tiên của display name không nằm trong danh sách họ `FAMILIES`), thay vì gán độ ưu tiên cao nhất (`priority = 4`) cho từ đầu tiên (`matchIndex === 0`), thuật toán đã được sửa để gán cho từ áp chót đứng trước họ (`matchIndex + sWords.length === mWords.length - 1` hoặc từ duy nhất đối với tên 1 chữ).
  - Thay đổi này giúp nhận diện chính xác `"Tiên"` là tên gọi chính trong chuỗi tên `"Thủy Tiên Triệu"`, đồng thời không làm ảnh hưởng đến việc so khớp cấu trúc Họ-Đệm-Tên truyền thống.

---

## 🗓️ 2026-07-23 — Phiên làm việc: Hỗ trợ xử lý tin nhắn gộp nhiều dòng cho Penalty & Bonus

### 📝 Yêu cầu
- Hỗ trợ xử lý tin nhắn gộp gồm nhiều dòng độc lập (multi-line grouped messages) khi thực hiện chấm điểm qua cú pháp chat trực tiếp.
- Người dùng có thể viết gộp nhiều dòng trong cùng một tin nhắn (ví dụ xuống dòng bằng Shift + Enter).
- Mỗi dòng cần được phân tích và xử lý độc lập với nhau về: nhân viên được chấm, điểm số (phạt/thưởng) và lý do chấm.
- Hỗ trợ thứ tự sắp xếp linh hoạt trên từng dòng (tên trước điểm sau, hoặc điểm trước tên sau, lý do có thể ở bất kỳ vị trí nào).
- Cập nhật số điểm tổng kết chạy liên tục (running total) chính xác giữa các dòng của cùng một tin nhắn.
- Đảm bảo tính tương thích ngược hoàn toàn (backward compatible): nếu người dùng chỉ nhập một dòng thì bot vẫn hoạt động theo luồng code cũ bình thường.

### ✅ Thay đổi — Áp dụng cho `main_test.js`

1. **Bổ dung block xử lý Multi-line (trước logic xử lý Single-line cũ):**
   - Tách tin nhắn theo ký tự xuống dòng `\n` và loại bỏ tiền tố lệnh `/Penalty&Bonus` ở dòng đầu tiên.
   - Nhận diện các dòng hợp lệ (yêu cầu phải tìm thấy ít nhất một nhân viên và một điểm số hợp lệ trên dòng đó).

2. **Ánh xạ Annotation của Google Chat (Mentions) vào từng dòng:**
   - Dựa trên thuộc tính `startIndex` và độ dài `length` của từng annotation để xác định chính xác thẻ mention đó thuộc dòng thứ mấy trong chuỗi văn bản gốc.
   - Bổ sung cơ chế fallback: tự động quét khớp từ tên hiển thị (display name) không dấu vào các dòng nếu API Google Chat không cung cấp `startIndex`.

3. **Chiến lược so khớp nhân viên độc lập cho mỗi dòng:**
   - Ưu tiên 1: So khớp từ Mention Annotation của Google Chat.
   - Ưu tiên 2: Quét tên viết dưới dạng `@tên` trong nội dung dòng.
   - Ưu tiên 3: Quét so khớp tên thường (không cần `@`) của nhân viên trong dòng.

4. **Trích xuất điểm số và lý do riêng biệt:**
   - Điểm số được định danh riêng trên từng dòng (hỗ trợ các ký tự dấu cộng/trừ đặc biệt).
   - Xóa bỏ các thông tin nhiễu (mentions, tên đã khớp, điểm số, ký tự `@` lẻ) trên dòng để lấy lý do sạch nhất.

5. **Ghi nhận lịch sử và hiển thị kết quả:**
   - Ghi độc lập từng dòng bản ghi hợp lệ vào Sheet Private.
   - Cập nhật dồn điểm `hearts`/`bombs` vào `scoreMap` ngay trong vòng lặp để dòng tiếp theo hiển thị đúng `Total until Now` (không bị trễ điểm).
   - Tổng hợp kết quả phản hồi của tất cả các dòng và các lỗi (nếu có dòng nào thiếu thông tin) thành một tin nhắn duy nhất trả về không gian chat.

---

## 🗓️ 2026-07-22 — Phiên làm việc: Tách biệt Tổng Tim/Bom & In đậm thông tin phản hồi Bot

### 📝 Yêu cầu
- Tách riêng tổng số tim (`❤️`) và tổng số bom (`💣`) trong dòng thông báo kết quả `Total until Now`, thay vì gộp chung thành tổng điểm Net như trước.
- **In đậm câu trả lời của Bot**: Yêu cầu câu trả lời của AI tự động in đậm các thông tin quan trọng (Tên nhân viên, Số lần muộn/quên, Ngày tháng, Số tim/bom, Điểm tổng kết...) khi gửi lên Google Chat.
- Cập nhật model chính trong cấu hình fallback sang `gemini-3.5-flash`.

### ✅ Thay đổi — Áp dụng cho `main_test.js`

1. **In đậm thông tin trong phản hồi Google Chat & Lệnh `/Penalty&Bonus`:**
   - **Google Chat Slash Command (`/Penalty&Bonus`)**: Bổ sung cú pháp in đậm `*` trực tiếp trong mã nguồn JS cho Tên nhân viên (`*VPA.Thanh*`), Điểm số (`*+2 ❤️*`), `*Reason:*` và `*Total until Now:* *6 ❤️ ; 5 💣*`.
   - **Gemini AI Response (`promtp`, `promtp1`)**: Cập nhật chỉ thị prompt cho Gemini bắt buộc dùng định dạng Markdown **in đậm** (`**nội dung**`) cho các dữ liệu trọng tâm. Regex ở dòng 742 (`answer.replace(/\*\*([^*\n]+)\*\*/g, '*$1*')`) sẽ chuyển đổi thành cú pháp `*nội dung*` chuẩn của Google Chat.

2. **Hàm `getEmployeeTotalScores(usePrivate)`:**
   - Cập nhật logic trả về đối tượng chi tiết: `{ stdName: { hearts: X, bombs: Y, total: Z } }`.
   - Đọc và cộng dồn điểm thưởng (`point > 0` → `hearts`) và điểm phạt (`point < 0` → `bombs`) từ dữ liệu lịch sử.
   - Kết hợp đọc đối chiếu dữ liệu bảng tổng kết từ `DashBoard`/`Merge Data`.

3. **Hàm `formatTotalLine(selectedEmployees, scoreMap, addedPoint)`:**
   - Thay đổi định dạng chuỗi kết quả: `X ❤️ ; Y 💣`.
   - Khi có điểm mới (`addedPoint`), tự động cộng dồn vào tim hoặc bom tương ứng trước khi xuất chuỗi.

4. **Hàm `getPenaltyData()`:**
   - Đồng bộ thông tin tổng kết gửi sang prompt cho Gemini: `Nhân Viên: [Tên], tổng tim: X ❤️, tổng bom: Y 💣`.

5. **Danh sách `FALLBACK_MODELS`:**
   - Cập nhật model chính từ `gemini-3-flash` sang `gemini-3.5-flash`.

---

## 🗓️ 2026-07-21 — Phiên làm việc: Tối ưu thông báo Penalty/Bonus & Hiển thị Avatar Bot (200 AI [App])

### 📝 Yêu cầu
- Đánh penalty/bonus qua lệnh `/Penalty&Bonus` trả về trực tiếp thông báo kết quả thay vì tin nhắn phản hồi phụ.
- Sửa lỗi hiển thị tên người gửi trong Google Chat: Thay vì hiển thị `You [200 AI]` kèm avatar người đánh, chuyển thành **`200 AI [App]`** kèm avatar chính thức của Bot (Logo ADD).

### ✅ Thay đổi — Áp dụng cho `main_test.js`
1. **Luồng chat lệnh trực tiếp (`onMessage`):**
   - Thay thế `Chat.Spaces.Messages.create` bằng hàm `sendMessageByChatBot({ text: mess }, space)`.
   - Hàm `sendMessageByChatBot` sử dụng Service Account (`id-00ai@...`) mang scope `chat.bot` giúp tin nhắn đăng lên mang tên và avatar chính thức **200 AI [App]**.
   - Trả về `return;` sau khi gửi thành công để không xuất hiện tin nhắn phụ trùng lặp.
2. **Luồng Form nhập liệu (`submitDialog`):**
   - Đổi `Chat.Spaces.Messages.create` sang `sendMessageByChatBot({ text: mess }, space)` để đồng bộ avatar **200 AI [App]** khi submit qua Dialog.

---

## 🗓️ 2026-07-20 — Phiên làm việc: Sửa đổi hiển thị Tổng điểm Net (Hàng I)

### 📝 Yêu cầu
- Hiển thị tổng điểm thực tế (tổng số bom cộng với điểm bonus ra kết quả cuối cùng ở hàng I).
- Chỉ thông báo một biểu tượng cảm xúc duy nhất đại diện cho trạng thái điểm: nếu điểm dương hoặc bằng không thì hiển thị hình Trái tim (`❤️`), nếu điểm âm thì hiển thị hình Quả bom (`💣`).
- Sửa lỗi tổng điểm bị tính sai / trả về giá trị cũ ngay sau khi sếp vừa chấm.

### ✅ Thay đổi 1 — Đọc trực tiếp từ cột dữ liệu tổng kết I và J
Cập nhật lại hàm `getEmployeeTotalScores(usePrivate)` để đọc trực tiếp điểm số đã tính toán trong cột I (9) và tên trong cột J (10) từ Sheet, thay vì tính tay lại từ danh sách lịch sử.
- Thêm tham số `usePrivate`: nếu `true` thì đọc từ `PRIVATE_SPREADSHEET_ID`, nếu `false`/không truyền thì đọc từ `SPREADSHEET_ID` (public).

### ✅ Thay đổi 2 — Hàm `formatTotalLine()` hiển thị Net Score
- Nhận thêm tham số `addedPoint` (điểm vừa chấm).
- Tính tổng mới = điểm cũ (từ cột I) + điểm vừa chấm (`addedPoint`).
- Nếu tổng mới `>= 0`: Hiển thị `X ❤️` (Ví dụ: `Total until Now: 0 ❤️`, `Total until Now: 5 ❤️`).
- Nếu tổng mới `< 0`: Hiển thị `X 💣` (Ví dụ: `Total until Now: 2 💣` khi tổng thực tế là -2).

### ✅ Thay đổi 3 — Sửa lỗi tổng điểm bị sai (Fix quan trọng)
**Nguyên nhân gốc:** Bot ghi dữ liệu vào Sheet Private → công thức ở cột I (Merge Data) chưa kịp cập nhật hoặc tham chiếu sang sheet khác → đọc ra điểm cũ → hiển thị tổng sai.

**Cách sửa:** Đọc tổng điểm hiện tại từ cột I **TRƯỚC KHI** ghi dữ liệu mới, rồi tự cộng `pointValue` vào điểm cũ để ra kết quả chính xác:
```
newTotal = oldScore (từ cột I trước khi ghi) + pointValue (điểm vừa chấm)
```

**Áp dụng cho cả 2 luồng:**
- Lệnh chat trực tiếp (`onMessage` — dòng ~335)
- Submit từ form dialog (`submitDialog` — dòng ~2335)

Loại bỏ `SpreadsheetApp.flush()` vì không còn cần thiết (không đọc lại sheet sau khi ghi nữa).

---

## 🗓️ 2026-07-20 — Phiên làm việc: Tách biệt Sheet Ghi (Private) & Sheet Đọc (Public)

### 📝 Yêu cầu
Giải quyết vấn đề phân quyền:
- Sếp cần dùng lệnh `/Penalty&Bonus` để ghi dữ liệu phạt/thưởng vào Sheet nội bộ (Private) chỉ sếp có quyền truy cập (`1lLU...`).
- Nhân viên cấp dưới cần chat hỏi bot bình thường, bot cần đọc dữ liệu phạt/thưởng từ Sheet công khai (Public) mà mọi người đều có quyền xem (`1Up1...`).

### ✅ Thay đổi — Định nghĩa 2 biến ID Spreadsheet riêng biệt
- Định nghĩa `PRIVATE_SPREADSHEET_ID` trỏ đến Sheet của Sếp (`1lLU...`). Dùng cho các hành động **Ghi nhận** (`submitDialog`, `onMessage` ghi penalty) và **Phân quyền** (`authorizationUser`).
- Giữ nguyên `SPREADSHEET_ID` trỏ đến Sheet công khai (`1Up1...`). Dùng cho các hành động **Đọc dữ liệu** (`getPenaltyData`, `getEmployeeTotalScores`) khi nhân viên chat hỏi bot.

---

## 🗓️ 2026-07-20 — Phiên làm việc: Hiển thị tổng điểm Penalty/Bonus

### 📝 Yêu cầu
Khi thực hiện lệnh `/Penalty&Bonus` hoặc submit dialog ghi nhận penalty/bonus thành công, bot cần hiển thị thêm dòng tổng điểm của nhân viên được chấm ở ngay dưới dạng:
```
VPA.Duong + 1 ❤️. Reason: Boss Bonus.
Total until Now: 5 ❤️
```

### ✅ Thay đổi 1 — Thêm hàm `getEmployeeTotalScores()`
Đọc cột I (điểm) và J (tên) từ sheet `Merge Data` để lấy tổng điểm tích luỹ thực tế đã được tính toán sẵn bởi công thức trong Sheet.

### ✅ Thay đổi 2 — Thêm hàm `formatTotalLine()`
- Xuống dòng (`\n`).
- Format đầu ra: `Total until Now: X ❤️` (dương) hoặc `Total until Now: X 💣` (âm).
- Nếu chấm nhiều người cùng lúc, hiển thị kèm tên: `VPA.Duong: 5 ❤️ | VPA.Thanh: 2 💣`.

### ✅ Thay đổi 3 — Áp dụng cho `main_test.js`
Đã sửa đổi ở file `main_test.js` cho cả 2 luồng: lệnh chat trực tiếp và submit từ form dialog.

---

## 🗓️ 2026-07-20 — Phiên làm việc: Model Fallback

### 📝 Yêu cầu
Thêm cơ chế **tự động chuyển sang model backup** khi model chính bị:
- Rate limit (quá giới hạn gọi API)
- Server busy (máy chủ quá tải)
- Timeout sau 30s hoặc 60s

---

### ✅ Thay đổi 1 — Thêm cấu hình `FALLBACK_MODELS`

**Vị trí:** Trước hàm `sendtoGemini()` (~dòng 1088)

**Mô tả:** Thêm mảng cấu hình danh sách model theo thứ tự ưu tiên. Dễ chỉnh sửa, thêm/bớt model mà không cần sửa logic.

```js
var FALLBACK_MODELS = [
  { name: "gemini-3-flash",        timeoutMs: 30000 },  // Model chính - timeout 30s
  { name: "gemini-3.1-flash-lite", timeoutMs: 60000 },  // Backup 1 - timeout 60s
  { name: "gemini-2.5-flash",      timeoutMs: 60000 },  // Backup 2 - timeout 60s
  { name: "gemini-2.5-flash-lite", timeoutMs: 60000 },  // Backup 3 - timeout 60s
];
```

> ⚠️ **Lưu ý:** Các tên model được cập nhật lại trong phiên do `gemini-2.5-flash` và `gemini-2.0-flash`
> bị lỗi 404 "no longer available to new users".

---

### ✅ Thay đổi 2 — Thêm hàm `callGeminiModel()`

**Vị trí:** ~dòng 1102

**Mô tả:** Tách logic gọi 1 model ra thành hàm riêng. Hàm trả về object `{ success, text, shouldFallback, error }`.

**Các trường hợp được xử lý:**

| HTTP Code | Hành động |
|-----------|-----------|
| 200 OK | Trả về text |
| 200 nhưng body rỗng | Fallback sang model khác |
| 200 nhưng có RESOURCE_EXHAUSTED trong body | Fallback |
| 404 Model unavailable | Fallback sang model khác |
| 429 Rate limit | Fallback |
| 500 Internal server error | Fallback |
| 502 Bad Gateway | Fallback |
| 503 Server busy | Fallback |
| 400 Bad request | Dừng (lỗi do input) |
| 403 Forbidden | Dừng (lỗi do API key) |
| Exception (timeout, network) | Fallback |

**Tính năng đo timeout:**
```js
var startTime = new Date().getTime();
var response = UrlFetchApp.fetch(url, options);
var elapsed = new Date().getTime() - startTime;
if (elapsed >= timeoutMs) {
  // Fallback sang model tiếp theo
}
```

---

### ✅ Thay đổi 3 — Cập nhật hàm `sendtoGemini()`

**Vị trí:** ~dòng 1197

**Mô tả:** Thay vì gọi cứng 1 model duy nhất, hàm giờ duyệt qua `FALLBACK_MODELS` và tự động thử model tiếp theo nếu gặp lỗi.

**Luồng fallback:**

```
gemini-3-flash (30s)
  fail → chờ 1s → gemini-3.1-flash-lite (60s)
    fail → chờ 1s → gemini-2.5-flash (60s)
      fail → chờ 1s → gemini-2.5-flash-lite (60s)
        fail → trả thông báo lỗi cho người dùng
```

**Log hệ thống ví dụ:**
```
[AI] Đang thử model: gemini-3-flash (timeout: 30000ms)
[Fallback] Model gemini-3-flash bị rate limit (HTTP 429). Chuyển model...
[AI] Đang thử model: gemini-3.1-flash-lite (timeout: 60000ms)
[AI] Fallback thành công! Đã dùng model backup: gemini-3.1-flash-lite
```

---

### 🐛 Fix — HTTP 404 gây dừng thay vì fallback

**Thời điểm:** Sau khi deploy lần đầu, gặp lỗi:
```
Request failed returned code 404.
"This model models/gemini-2.5-flash is no longer available to new users."
```

**Vấn đề:** Code cũ xử lý tất cả 4xx (trừ 429) là "không fallback" — dừng luôn khi gặp 404.

**Fix:** Thêm case riêng cho 404 → fallback sang model tiếp theo.

```js
// Trước khi fix — 404 bị dừng luôn:
if (responseCode >= 400 && responseCode < 500 && responseCode !== 429) {
  return { shouldFallback: false };
}

// Sau khi fix — 404 chuyển model:
if (responseCode === 404) {
  return { shouldFallback: true };
}
if (responseCode >= 400 && responseCode < 500) {
  return { shouldFallback: false }; // Chỉ dừng với 400, 403
}
```

---

## 🗓️ 2026-07-29 — Phiên làm việc: Tối ưu Fallback Model, Bộ lọc Spam/Greeting & Phân luồng Prompt AI

### 📝 Yêu cầu & Vấn đề xử lý
1. **Sửa tên Model & Tối ưu Timeout/Deadline**:
   - Cập nhật danh sách `FALLBACK_MODELS`, xếp model chạy ổn định (`gemini-3.5-flash-lite`) lên vị trí số 1 để tránh dính lỗi HTTP 404 ban đầu.
   - Giảm `deadlineMs` xuống **12 giây** giúp `UrlFetchApp.fetch()` thoát sớm, đảm bảo bot có đủ thời gian thử model backup mà không bị Google Chat ngắt kết nối (`Timed Out` 28s).

2. **Cải tiến bộ lọc nhận diện Spam & Lời chào (`isGreetingOrUnrelated`)**:
   - Bổ sung 6 lớp lọc thông minh phát hiện các loại tin nhắn rác, gõ phím vô nghĩa (`j`, `...`, `dasldsal;dkl;askdkd;lá`...), ký tự lặp lại hoặc tin nhắn không có khoảng trắng ➔ Tự động trả về `WELCOME_MESSAGE` tránh gọi Gemini lãng phí.
   - Thêm bộ kiểm tra chủ đề nghiệp vụ (`hasSpecificTopic`): Khi câu hỏi chứa các từ khóa cụ thể như *tăng ca*, *văn phòng phẩm*, *nghỉ việc*, *chấm công*... (VD: *"hướng dẫn tôi đăng ký tăng ca"*), hệ thống cho qua bộ lọc greeting để Gemini trả lời đúng trọng tâm 1-2 dòng thay vì in lại menu Welcome Message.

3. **Phân luồng nạp dữ liệu thông minh (Lazy Loading)**:
   - **Quy định công ty (`companyRule`)**: Luôn luôn nạp vào Prompt vì là chuỗi trong bộ nhớ (0ms), giúp AI luôn biết công thức tính phạt trừ ngày công (Điều 2), thông tin quy định nghỉ việc và link của tất cả 100% mẫu đơn/biên bản (bao gồm cả *Biên nhận tiền*).
   - **Dữ liệu Chấm công & Penalty**: Chỉ đọc từ Google Sheet khi người dùng thực sự hỏi về dữ liệu chấm công hoặc điểm số tích lũy ➔ Giảm thời gian xử lý AI từ 25s xuống chỉ còn 2–4s.

4. **Tối ưu hóa Phản hồi AI Đúng trọng tâm (Prompt Engineering)**:
   - **Loại bỏ dòng ngày cập nhật chấm công vô lý**: Cấm in dòng *"Dữ liệu chấm công được cập nhật đến ngày..."* ở đầu câu trả lời đối với các câu hỏi không liên quan đến chấm công (như xin mẫu biên bản bàn giao, hỏi thủ tục nghỉ việc, công tác phí, hướng dẫn đăng ký tính năng...).
   - **Ép buộc ngôn ngữ Tiếng Hàn 100% (Strict Language Matching)**: Khi câu hỏi viết bằng Tiếng Hàn (한국어), AI bắt buộc trả lời 100% bằng Tiếng Hàn (존댓말), tuyệt đối không trộn Tiếng Việt.
   - **Khớp tên dạng Mã.Tên (Code Mapping)**: Thêm quy tắc đối chiếu tên dạng `Mã.Tên` (VD: `000.Luat` ➔ `Tô Vũ Luật`) để AI luôn tra cứu đúng 9 ❤️ của Tô Vũ Luật thay vì báo `0 ❤️ 0 💣`.
   - **Chỉ xuất Dữ liệu Tổng kết Penalty & Bonus**: Loại bỏ hoàn toàn bảng chi tiết các lần đánh giá dính kèm trong `getPenaltyData()`. AI chỉ trả về tổng số tim ❤️ và tổng số bom 💣 tích lũy từ Sheet Public (`SPREADSHEET_ID`).

---

## 📊 Tóm tắt file thay đổi

| File | Loại | Mô tả |
|------|------|-------|
| `main_test.js` | Sửa | Tối ưu model fallback, bộ lọc rác/greeting, phân luồng lazy loading, prompt tiếng Hàn và hiển thị tổng penalty |
| `CHANGELOG.md` | Cập nhật | Lưu lại toàn bộ lịch sử cuộc trò chuyện và chi tiết thay đổi code |

---

*Cập nhật lần cuối: 2026-07-29 12:00*

---

## 🗓️ 2026-08-11 — Phiên làm việc: Cải tiến tính năng Đăng ký Con dấu & Xóa Payment Request

### 📝 Yêu cầu & Giải pháp

#### 1. Xóa hoàn toàn tính năng Payment Request (VPA & ADD) (`main_test.js`)
- **Yêu cầu:** Gỡ bỏ thẻ VPA Payment Request và ADD Payment Request không còn sử dụng.
- **Thay đổi:**
  - Xóa hàm `handlePayment(params)` và toàn bộ logic xử lý `approveVPA`, `rejectVPA`, `approveADD`, `rejectADD`.
  - Xóa nhánh điều hướng tương ứng trong hàm `onCardClick`.

#### 2. Bỏ gửi email khi đăng ký dấu (`submitStampDocument`)
- **Yêu cầu:** Khi người dùng đăng ký dấu, chỉ hiện thông báo trong ứng dụng 200 AI, không gửi email nữa.
- **Thay đổi:**
  - Xóa toàn bộ khối `GmailApp.sendEmail` và `MailApp.sendEmail` trong `submitStampDocument`.
  - Xóa `Utilities.sleep(3500)` vì không còn cần chờ email hiển thị trước.

#### 3. Thay đổi tiêu đề Card thông báo đăng ký dấu
- **Yêu cầu:** Tiêu đề card trong nhóm `200.Notification` thay vì hiện `🔏 YÊU CẦU ĐÓNG DẤU MỚI` thì hiện tên các loại dấu được chọn.
- **Thay đổi:**
  - Cập nhật `title` của card từ chuỗi cố định sang `'🔏 ĐĂNG KÝ SỬ DỤNG CON DẤU'` (header cố định theo yêu cầu người dùng).

#### 4. Hiển thị Loại dấu xuống từng dòng
- **Yêu cầu:** Trong card thông báo đăng ký dấu và card sau khi ACCEPT/REJECT, mỗi loại dấu hiện trên 1 dòng riêng biệt để dễ đọc.
- **Thay đổi:**
  - Cập nhật widget `Loại dấu` trong `submitStampDocument` (card gửi vào `200.Notification`) dùng `allStamps.map(...).join('\n')` thay vì chuỗi phẳng.
  - Cập nhật widget `Loại dấu` trong `handleStampReturn` (card cập nhật sau khi bấm ACCEPT/REJECT) dùng `.split(', ').map(...).join('\n')`.

#### 5. Cải thiện hiển thị thông tin người xác nhận trong card sau ACCEPT/REJECT
- **Yêu cầu:** Card sau khi bấm ACCEPT/REJECT cần hiện rõ tên người xác nhận ở vị trí nổi bật.
- **Thay đổi trong `handleStampReturn`:**
  - Subtitle của card cập nhật thành `'👤 [Tên người xác nhận] — [Giờ/Ngày]'` thay vì tên người đăng ký.
  - Dòng người xác nhận đổi thành `👤 Xác nhận bởi: **[Tên người nhấn]**` (in đậm).

### 📂 File đã sửa

| File | Hàm / Vùng code | Thay đổi |
|------|-----------------|----------|
| `main_test.js` | `onCardClick` | Xóa nhánh `approveVPA`, `rejectVPA`, `approveADD`, `rejectADD` |
| `main_test.js` | `handlePayment` | **[XÓA]** Toàn bộ hàm xử lý Payment Request |
| `main_test.js` | `submitStampDocument` | Xóa khối gửi email, xóa `Utilities.sleep(3500)` |
| `main_test.js` | `submitStampDocument` | Widget Loại dấu hiển thị xuống từng dòng (`• Tên dấu`) |
| `main_test.js` | `handleStampReturn` | Subtitle card hiện tên người xác nhận |
| `main_test.js` | `handleStampReturn` | Widget Loại dấu xuống từng dòng; người xác nhận in đậm |

---

*Cập nhật lần cuối: 2026-08-11 17:28*

