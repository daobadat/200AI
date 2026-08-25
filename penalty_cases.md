# Hướng Dẫn Cú Pháp Chatbot 200AI (/Penalty&Bonus)

Tài liệu này tổng hợp chi tiết các trường hợp cú pháp **Hợp lệ (Thành công)** và **Không hợp lệ (Thất bại)** khi sử dụng lệnh `/Penalty&Bonus` của Chatbot 200AI.

---

## 1. Các Trường Hợp Thành Công (Hợp lệ)

Đây là những cú pháp chuẩn và các trường hợp linh hoạt được hệ thống chấp nhận và ghi nhận thành công vào Google Sheet.

| STT | Ví dụ Câu Lệnh | Điểm Nhận Diện | Kết Quả Ghi Nhận |
| :--- | :--- | :--- | :--- |
| **1** | `/Penalty&Bonus @Đỗ Duy Anh +2 đi muộn` | Cú pháp chuẩn: Có dấu `+`, có khoảng cách, có lý do rõ ràng. | Cộng **2** điểm cho Đỗ Duy Anh.<br>Lý do: `"đi muộn"` |
| **2** | `/Penalty&Bonus @Đỗ Duy Anh -2 đi muộn` | Cú pháp chuẩn: Có dấu `-`, có khoảng cách, có lý do rõ ràng. | Trừ **2** điểm cho Đỗ Duy Anh.<br>Lý do: `"đi muộn"` |
| **3** | `/Penalty&Bonus @Đỗ Duy Anh 2 làm tốt` | **Không ghi dấu cộng/trừ**.<br>Hệ thống tự động hiểu số dương là cộng điểm. | Cộng **2** điểm cho Đỗ Duy Anh.<br>Lý do: `"làm tốt"` |
| **4** | `/Penalty&Bonus @Đỗ Duy Anh.-2` | **Viết liền không có khoảng cách sau dấu chấm**.<br>Đã được cấu hình tự động sửa lỗi khoảng trắng. | Trừ **2** điểm cho Đỗ Duy Anh.<br>Lý do: `" "` (khoảng trắng tự động) |
| **5** | `/Penalty&Bonus @Đỗ Duy Anh - 2` | **Có khoảng cách** giữa dấu và số điểm. | Trừ **2** điểm cho Đỗ Duy Anh. |
| **6** | `/Penalty&Bonus @Đỗ Duy Anh –2 lý do` | Sử dụng các loại **dấu trừ Unicode đặc biệt** (như `–`, `—`, `−`). Hệ thống sẽ tự chuẩn hóa về dạng chuẩn `-`. | Trừ **2** điểm cho Đỗ Duy Anh. |
| **7** | `/Penalty&Bonus @Đỗ Duy Anh 2` | **Không ghi lý do**.<br>Hệ thống tự động điền một khoảng trắng `" "` làm lý do hợp lệ. | Cộng **2** điểm cho Đỗ Duy Anh. |
| **8** | `/Penalty&Bonus @Đỗ Duy Anh @Luật Tô Vũ -1` | **Gắn thẻ nhiều nhân viên cùng lúc**.<br>Ghi nhận độc lập cho từng người. | Trừ **1** điểm cho cả 2 nhân sự (tạo thành 2 dòng riêng biệt trên sheet). |
| **9** | `/Penalty&Bonus Đỗ Duy Anh -1` | **Không dùng ký tự `@`**.<br>Chỉ cần viết đúng tên hoặc tên viết tắt (Short Name) của nhân viên. | Trừ **1** điểm cho Đỗ Duy Anh. |
| **10** | (Tài khoản Sếp gõ lệnh bất kỳ) | Người thực hiện là `boss@add-group.net`. | **Bypass qua hoàn toàn bước xác thực OAuth** và thực thi lệnh trực tiếp. |

---

## 2. Các Trường Hợp Thất Bại (Không Hợp Lệ)

Dưới đây là các cú pháp sai hoặc trường hợp bị hệ thống từ chối ghi nhận và gửi thông báo lỗi trên khung chat.

| STT | Ví dụ Câu Lệnh | Nguyên Nhân Thất Bại | Thông Báo Lỗi Hiển Thị |
| :--- | :--- | :--- | :--- |
| **1** | `/Penalty&Bonus @Đỗ Duy Anh +6 lý do` | **Sai dải điểm** (Hệ thống chỉ chấp nhận điểm từ 1 đến 5 hoặc -1 đến -5). | *Không tìm thấy điểm số. Vui lòng nhập điểm số hợp lệ từ -5 đến 5...* |
| **2** | `/Penalty&Bonus @Đỗ Duy Anh 0 lý do` | Điểm số bằng `0` không hợp lệ. | *Không tìm thấy điểm số. Vui lòng nhập điểm số hợp lệ từ -5 đến 5...* |
| **3** | `/Penalty&Bonus @Người Lạ +2 lý do` | Tên nhân viên được nhắc tới **không tồn tại** trong danh sách nhân sự trên sheet cấu hình. | *Không tìm thấy nhân viên nào được gắn thẻ hoặc nhắc tên trong câu lệnh...* |
| **4** | `/Penalty&Bonus +2 đi muộn` | **Thiếu thông tin người bị phạt/thưởng** (không tag cũng không viết tên). | *Không tìm thấy nhân viên nào được gắn thẻ hoặc nhắc tên trong câu lệnh...* |
| **5** | `/Penalty&Bonus @Đỗ Duy Anh lý do` | **Thiếu số điểm thưởng/phạt**. | *Không tìm thấy điểm số. Vui lòng nhập điểm số hợp lệ từ -5 đến 5...* |
| **6** | `/Penalty&Bonus @Đỗ Duy Anh 123` | Số điểm ghi dính liền tạo thành số lớn nằm ngoài dải 1-5. | *Không tìm thấy điểm số. Vui lòng nhập điểm số hợp lệ từ -5 đến 5...* |
| **7** | (Nhân viên thường gõ lệnh khi chưa liên kết) | Tài khoản của người gõ lệnh chưa thực hiện xác thực với chatbot. | *You are not authenticated. Please visit this link to authenticate* |
| **8** | (Nhân viên không có quyền quản trị gõ lệnh) | Tài khoản gõ lệnh không nằm trong danh sách Leader/Admin ở Sheet cấu hình. | *Bạn không có quyền thực hiện hành động này ⚠️.* |
