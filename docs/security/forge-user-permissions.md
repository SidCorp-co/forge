# Forge — Quản lý resource & quyền của user

Một user có gì, vào được đâu, ai mới làm admin. Backend: `forge-beta-api.sidcorp.co`.

## 1. User sở hữu gì

Mọi resource neo vào một **Project** — không có Issue mồ côi.

```
User ──(own / member)──> Project ──> Issue ──> Task / Comment / File đính kèm
                                 ├──> Pipeline run (AI tự chạy quy trình)
                                 └──> Agent session (phiên AI làm việc)
```

## 2. Bốn cửa vào (cùng một backend, khác "chìa khoá")

| Cửa | Chìa khoá |
|---|---|
| 🌐 Web (`forge-beta.sidcorp.co`) | Cookie đăng nhập (`forge_auth` / JWT) |
| 📱 Mobile | Cookie đăng nhập |
| 💻 Desktop (Forge Dev) | Mã ghép cặp thiết bị → device token |
| 🔑 Script / AI tool (Claude, Cursor…) | Personal Access Token (PAT), lấy ở `/settings` |

## 3. Hai lớp quyền

- **Lớp 1 — owner/member theo từng project.** Mọi user login là owner project của chính mình (toàn quyền trong phạm vi đó). Member được mời chỉ thấy/sửa project được mời. Mutation nhạy cảm (archive, mời người, quản runner) cần owner/admin của project đó. Không liên quan project → `403` / `NOT_FOUND`.
- **Lớp 2 — admin REST, độc lập.** Chỉ email trong `ADMIN_EMAILS` (env, cấu hình khi deploy) mới vào `/api/admin/*`; còn lại `403 ADMIN_ONLY`.

> AI tool `forge_admin_*` và metrics **giới hạn theo phạm vi user** (chỉ project own/member, **không cross-tenant**). `forge_admin_projects create` luôn đặt người gọi làm owner.

## 4. Cửa nào làm được gì

| Hành động | 🌐/📱 (cookie) | 💻 Desktop | 🔑 PAT |
|---|---|---|---|
| Xem/sửa Issue trong project mình là member | ✅ | ✅ (qua AI tool) | ✅ (qua AI tool) |
| Tạo project qua web | ✅ | ❌ | ❌ |
| Tạo project qua `forge_admin_projects create` | ❌ | ✅ (người gọi → owner) | ✅ (cần scope write; người gọi → owner) |
| Mời user vào project mình sở hữu | ✅ | ❌ | ❌ |
| Admin toàn hệ thống qua REST `/api/admin/*` | chỉ khi email ∈ `ADMIN_EMAILS` | ❌ | ❌ |
| `forge_admin_*` / metrics cross-project | ❌ | ✅ nhưng chỉ phạm vi own/member | ✅ nhưng chỉ phạm vi own/member |

## 5. Thiết lập user mới

- **Làm trên project có sẵn** → owner add làm member → thấy/sửa qua web.
- **Project riêng** → tự tạo, là owner.
- **Dùng AI tool / MCP** → `/settings` tạo PAT → cài vào Claude/Cursor (thao tác trong phạm vi own/member).
- **Cần admin REST** → maintainer thêm email vào `ADMIN_EMAILS` + redeploy (chỉ bước này cần cấu hình hạ tầng).

## 6. Mapping thuật ngữ

| Trong code | Nghĩa |
|---|---|
| `JWT` / `forge_auth` cookie | Phiên đăng nhập web/mobile |
| Device token | Chìa khoá của máy đã ghép cặp (desktop) |
| `PAT` | Token cá nhân, dán vào script / AI tool |
| `projectMembers` | "Ai được vào project nào" |
| `ADMIN_EMAILS` | Danh sách email admin REST (config khi deploy) |
| `forge_admin_*` (MCP) | AI tool quản trị, giới hạn phạm vi user, không cross-tenant |
