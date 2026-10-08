## PK-01 (S): Màn đăng nhập cho tài khoản TEST nhân viên
Route: / và /pages/staff
Thiết kế liên quan: hop-staff-shell-ux r7 · REQ-25
crmhp: crmhp có một thẻ đăng nhập trắng trên nền xám: kicker "SIDCORP × NAM SÀI GÒN HOSPITAL", tiêu đề, dòng "Truy cập nội bộ. Vui lòng đăng nhập để xem.", hai ô bắt buộc Tài khoản/Mật khẩu, nút Đăng nhập (bận: "Đang mở…"), lỗi "Tài khoản hoặc mật khẩu không đúng.", chân "Bản demo · truy cập nội bộ", giữ phiên trong tab. Không có quên mật khẩu, SSO hay đăng xuất.
HOP hiện tại: HOP đã có đăng nhập thật (email + mật khẩu, POST /auth/login, phiên lưu trình duyệt, hết hạn quay lại màn đang mở, Đăng xuất, giao diện sáng/tối). Khác mockup về nền (navy toàn màn) và chưa có tài khoản TEST nào thấy đủ menu.
Tiêu chí nghiệm thu:
- Mở https://hop.auto.sidcorp.co/ khi chưa đăng nhập thấy thẻ "Đăng nhập HOP" với logo NAM SÀI GÒN, ô Email, ô Mật khẩu và nút Đăng nhập; không thấy menu nào.
- Nền và thẻ theo mockup crmhp: thẻ trắng bo 12px, rộng tối đa 360–420px, giữa màn, trên nền sáng #f5f7f9 (chế độ tối giữ nền tối); có dòng nhỏ "Bản demo · truy cập nội bộ" ở chân thẻ.
- Bấm Đăng nhập khi để trống cả hai ô thấy "Nhập email và mật khẩu." bằng tiếng Việt ngay trong thẻ, không gọi máy chủ.
- Nhập sai mật khẩu thấy "Không đăng nhập được: email hoặc mật khẩu không đúng (mã 401)." và ô mật khẩu được xóa.
- Trong lúc chờ, nút hiện "Đang đăng nhập…" và hai ô bị khóa.
- Đăng nhập đúng bằng từng tài khoản TEST trong danh sách (coordinator, callcenter, vipdesk, patientrelations, carelead, clinops, opsmanager, hospitalit, mkt.crm, mkt.lead, loy.officer, consult1, consult.lead, dh.lab, cx.dual…) vào thẳng Tổng quan với đúng menu của vai trò.
- Có ít nhất một tài khoản TEST "demo toàn quyền" (vd demo.all.test@hop-demo.invalid) đăng nhập vào thấy đủ 11 mục menu như mockup: Tổng quan, Lead, CTV / Giới thiệu, Marketing, Lịch hẹn, Khách hàng, CSKH, Thành viên & điểm, Báo cáo & phân tích, Nhân sự & phân công, Cấu hình hệ thống.
- Tài khoản TEST có display_name (vd "Nguyễn Thị Mai") nên thẻ người dùng cuối sidebar và lời chào hiện họ tên, không hiện email.
- Tải lại trang sau khi đăng nhập không phải đăng nhập lại; bấm Đăng xuất quay về thẻ đăng nhập với dòng "Đã đăng xuất.".
- Tài khoản không có vai trò (norole.test) thấy "Tài khoản chưa được cấp vai trò HOP" và không có menu.
- Danh sách tài khoản TEST và mật khẩu chỉ nằm trong tệp cục bộ trên máy runner, không có trên trang, tracker hay repo.
