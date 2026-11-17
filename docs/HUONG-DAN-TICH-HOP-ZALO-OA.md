# Hướng dẫn tích hợp Zalo OA (API chính thức) vào ZaloCRM

Sau khi làm xong hướng dẫn này, shop sẽ có:

- **Tin nhắn Zalo OA hiện ngay trong mục Chat của CRM**, dưới một "nick" tên `OA · <tên OA>`. Nhân viên trả lời trong CRM, khách nhận tin từ OA.
- **Khách nhắn OA tự thành khách hàng trong CRM** (tên, ảnh, SĐT nếu khách chia sẻ). Nếu SĐT trùng khách đã có (từ Shopee, TikTok, Zalo cá nhân…), CRM gộp vào đúng hồ sơ cũ.
- **Lưu đủ lịch sử**: tin khách gửi, tin nhân viên trả lời trong CRM, và cả tin trả lời bằng app Zalo OA trên điện thoại.
- **Người theo dõi OA**: theo dõi/bỏ theo dõi tự gắn tag `auto:zalo_oa_follower` / `auto:zalo_oa_unfollowed`; có nút đồng bộ toàn bộ người theo dõi cũ về CRM.
- **ZNS**: gửi tin xác nhận đơn, nhắc lịch, chăm sóc sau mua theo số điện thoại (mẫu đã được Zalo duyệt), có nhật ký "đã gửi / khách đã nhận".
- **Thống kê 30 ngày**: số người theo dõi, khách mới, hội thoại, tin đang chờ trả lời, ZNS.
- Token Zalo **tự gia hạn** (30 phút kiểm tra một lần), không phải đăng nhập lại mỗi ngày.

> Tên các menu trên trang Zalo đôi khi đổi chữ theo thời gian. Nếu không thấy đúng tên, tìm mục có ý nghĩa tương tự.

---

## Chuẩn bị (kiểm tra trước)

1. **Tài khoản Zalo là quản trị viên của OA** HADO STORE.
2. **OA đã xác thực** và gói OA cho phép dùng API gửi tin (xem ở trang quản lý OA `oa.zalo.me` → Gói dịch vụ). Gói miễn phí có thể bị giới hạn gửi tin tư vấn qua API.
3. **CRM chạy bằng tên miền HTTPS**, ví dụ `https://crm.hadostore.shop`. Zalo **không** gọi được về `http://` hay `localhost`.
   - Trong file `.env` trên VPS, `APP_URL=https://crm.hadostore.shop` rồi khởi động lại CRM.
   - Cách bật HTTPS: xem mục 5 trong `docs/HUONG-DAN-TRIEN-KHAI-PRODUCTION-COMMUNITY.md`.

---

## Bước 1. Tạo ứng dụng Zalo (lấy App ID + Secret Key)

1. Vào **https://developers.zalo.me**, đăng nhập bằng tài khoản Zalo quản trị OA.
2. Chọn **Tạo ứng dụng mới** (hoặc "Thêm ứng dụng"). Đặt tên, ví dụ `HADO CRM`, chọn danh mục phù hợp, bấm tạo.
3. Mở ứng dụng vừa tạo. Ở trang **Thông tin ứng dụng / Cài đặt**, bạn thấy:
   - **ID ứng dụng (App ID)**: một dãy số dài.
   - **Khóa bí mật của ứng dụng (Secret Key)**: bấm hiện rồi copy.
4. Mở CRM → **Cài đặt → Kênh & Tự động → Zalo OA (API chính thức)**. Dán **App ID** và **Secret Key** vào ô tương ứng, bấm **Lưu cấu hình**.

> Không gửi Secret Key qua chat/Zalo/email. Chỉ dán thẳng vào CRM.

## Bước 2. Xác thực tên miền

Zalo yêu cầu chứng minh tên miền `crm.hadostore.shop` là của shop thì mới cho đặt webhook.

1. Trong ứng dụng trên developers.zalo.me, mở mục **Xác thực domain** (thường nằm trong phần Webhook hoặc Cài đặt).
2. Nhập tên miền `crm.hadostore.shop`, chọn cách xác thực **bằng file HTML**.
3. Zalo cho tải một file tên dạng `zalo_verifierXXXXXXXX.html`. **Không cần tải lên máy chủ**: chỉ copy **tên file** đó.
4. Dán tên file vào ô **Mã xác thực domain** trong trang Zalo OA của CRM, bấm **Lưu cấu hình**. CRM sẽ tự phục vụ file này. Bấm **Mở thử** để kiểm tra: trang mở ra được là đúng.
5. Quay lại Zalo, bấm **Xác thực**.

## Bước 3. Khai Callback URL và liên kết OA với ứng dụng

1. Trong ứng dụng, mở mục **Official Account** (hoặc "Thiết lập chung" của OA).
2. Ô **Official Account Callback URL**: dán **Callback URL** copy từ trang CRM, dạng:
   `https://crm.hadostore.shop/api/v1/zalo-oa/oauth/callback`
3. Ở phần **Quyền / Phân quyền API**, bật các quyền: gửi tin nhắn (tư vấn), quản lý/đọc thông tin người dùng (người quan tâm), và ZNS nếu dùng. Một số quyền cần Zalo duyệt.
4. Lưu lại.

## Bước 4. Khai Webhook (để tin nhắn chạy về CRM)

1. Trong ứng dụng, mở mục **Webhook**.
2. Ô **URL Webhook**: dán **Webhook URL** từ trang CRM, dạng:
   `https://crm.hadostore.shop/api/v1/webhooks/zalo-oa`
3. Trên cùng trang có **OA Secret Key** (khoá bí mật webhook). Copy và dán vào ô **OA Secret Key** trong CRM, bấm **Lưu cấu hình**. CRM dùng khoá này để kiểm tra tin đến đúng là từ Zalo.
4. Bật các sự kiện (event) sau:
   - Người dùng gửi tin: văn bản, hình ảnh, file, sticker, GIF, link, vị trí, âm thanh, video (`user_send_*`)
   - OA gửi tin (`oa_send_*`): để lưu cả tin nhân viên trả lời bằng app Zalo OA
   - Người dùng quan tâm / bỏ quan tâm OA (`follow`, `unfollow`)
   - Người dùng đã nhận / đã xem tin (`user_received_message`, `user_seen_message`)
   - Người dùng gửi thông tin (`user_submit_info`)
5. Lưu lại.

## Bước 5. Kết nối OA trong CRM

1. Trong CRM → trang Zalo OA, bấm **Kết nối Zalo OA**.
2. Trình duyệt chuyển sang Zalo. Chọn OA **HADO STORE**, bấm **Cho phép**.
3. Zalo đưa bạn quay lại CRM, thấy dòng xanh "Đã kết nối Zalo OA…" và OA có nhãn **Đang hoạt động**.
4. Bấm **Đồng bộ người theo dõi** để kéo danh sách người đã theo dõi OA về CRM (chạy nền, OA vài nghìn người mất vài phút).

## Bước 6. Thử ngay

1. Dùng một Zalo khác nhắn vào OA: "Ziaja còn hàng không shop?".
2. Mở **Chat** trong CRM, chọn nick **OA · HADO STORE**: tin nhắn hiện ra, khách mới xuất hiện trong **Khách hàng** với nguồn `zalo_oa`.
3. Trả lời trong CRM → khách nhận tin từ OA.
4. Trên trang Zalo OA, mục **Webhook gần nhất** cập nhật giờ vừa nhắn là thông suốt.

---

## Gửi ZNS (tin thông báo theo SĐT)

1. Tạo mẫu ZNS và nạp ví tại **https://account.zalo.cloud** (Zalo Cloud Account), chờ Zalo duyệt mẫu.
2. Trong CRM → trang Zalo OA → **Gửi thử ZNS** → **Tải danh sách mẫu ZNS** → chọn mẫu.
3. Điền SĐT, và **Dữ liệu mẫu** dạng JSON với đúng tên tham số trong mẫu, ví dụ:
   ```json
   {"customer_name": "Chị Lan", "order_code": "HD1024", "product": "Ziaja Med sữa rửa mặt", "price": "189000"}
   ```
4. Bấm **Gửi ZNS**. Bảng nhật ký bên dưới hiện trạng thái **Đã gửi / Khách đã nhận / Lỗi**.

Mỗi tin ZNS tính phí theo bảng giá Zalo (trừ vào ví Zalo Cloud).

---

## Lưu ý vận hành

- **Tin tư vấn có khung thời gian**: theo chính sách Zalo, OA chỉ được nhắn chủ động cho khách đã tương tác trong một khoảng thời gian gần đây. Nếu CRM báo "Zalo từ chối gửi", hãy chờ khách nhắn lại hoặc dùng ZNS.
- **Bản này gửi được tin chữ từ CRM.** Ảnh/file vẫn gửi bằng app Zalo OA trên điện thoại; lịch sử vẫn tự lưu về CRM.
- **Nick "OA · …" không quét QR.** Đừng bấm "Kết nối lại/quét QR" trên nick này ở trang Tài khoản Zalo. Trạng thái của nó do trang Zalo OA quản lý.
- **Chạy song song với Zalo cá nhân**: các nick Zalo cá nhân vẫn chạy như cũ. Có thể dần chuyển khách sang OA (an toàn hơn, không lo khoá nick).
- **Token lỗi** (nhãn đỏ "Lỗi — cần kết nối lại"): bấm **Kết nối thêm / kết nối lại OA** và cho phép lại. Lịch sử chat không mất.
- **Đổi `ENCRYPTION_KEY` / `TOKEN_ENCRYPTION_KEY` trong .env** sẽ làm CRM không đọc được khoá đã lưu: phải nhập lại Secret Key và kết nối lại OA.

## Sự cố thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| Bấm "Kết nối Zalo OA" báo "Chưa cấu hình App ID / Secret Key" | Làm Bước 1, bấm Lưu cấu hình. |
| Zalo báo lỗi redirect/callback không hợp lệ | Callback URL ở Bước 3 phải **giống hệt** Callback URL trên trang CRM (cả `https://`). |
| Khách nhắn OA nhưng CRM không hiện | Kiểm tra Bước 4: URL webhook đúng, đã bật sự kiện, domain đã xác thực. Xem "Webhook gần nhất" trên trang CRM. |
| Log máy chủ có dòng "webhook sai chữ ký" | OA Secret Key trong CRM khác trên Zalo. Copy lại ở trang Webhook của Zalo, dán vào CRM. |
| "Mở thử" file xác thực báo 404 | Chưa lưu mã xác thực, hoặc dán sai tên file. |
