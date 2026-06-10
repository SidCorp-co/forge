# Forge — Quản lý resource & quyền của user

Một user có gì, vào được đâu, ai mới làm admin. Backend: `forge-beta-api.sidcorp.co`.

## 1. Mô hình sở hữu

Mọi project thuộc đúng **một Organization** (`projects.org_id` NOT NULL). Mỗi user có một **personal org** tự tạo lúc signup (migration 0106 backfill cho user cũ). `projects.created_by` chỉ là audit — không mang quyền.

```
User ──(org role)──> Organization ──> Project ──> Issue / Run / Session / Connection-binding
User ──(project role)────────────────^
```

## 2. Hai tầng role + một lớp instance

| Tầng | Roles | Ý nghĩa |
|---|---|---|
| **Org** | `owner` > `admin` > `member` | owner/admin: implicit **project admin** trên MỌI project của org + quản org members + connection org-owned; `member`: chỉ được tạo project + dùng connection org — KHÔNG tự thấy project |
| **Project** | `admin` > `member` > `viewer` | admin: members/labels/runners/skills/bind connection; member: issues/runs/comments/chat; viewer: read-only |
| **Instance** | `ADMIN_EMAILS` env | chỉ gate REST `/api/admin/*` (operator self-host) — độc lập tenant |

**Một công thức duy nhất** (`packages/core/src/lib/authz.ts`):
`effectiveProjectRole = max(projectMembers.role, org owner/admin → 'admin')`. Mọi gate REST + MCP + WS đi qua module này.

Gate "chủ project" cũ (settings PATCH, DELETE, archive, pipeline-config) = **org owner/admin** (`assertOrgRoleOnProject`) — project admin được mời KHÔNG đủ.

## 3. Bốn cửa vào

| Cửa | Chìa khoá | Ghi chú |
|---|---|---|
| 🌐 Web / 📱 Mobile | Cookie `forge_auth` (JWT) | đầy đủ theo role |
| 💻 Desktop (Forge Dev) | Device token | hành xử như user (không có scope) |
| 🔑 Script / AI tool | PAT (`/settings`) | quyền user ∩ `projectIds` allowlist ∩ **scopes** |

**PAT scopes (enforced)**: `read` / `write` / `admin`. Mutation quản trị qua MCP (`forge_skills` update/push, `forge_projects.update/.archive`, `forge_config`…) cần scope `admin` (check tại `assertPrincipalIsAdmin`). PAT trước migration 0106 được grandfather thêm `admin`; PAT mới mặc định `read,write`.

## 4. Surface chính

- REST `/api/orgs` — CRUD org + members (add trực tiếp bằng email user có sẵn; project invite vẫn dùng email-token).
- `POST /api/projects` + `forge_projects.create` — nhận `orgId` optional (mặc định personal org); creator nhận project role `admin`.
- MCP `forge_orgs.list` / `forge_orgs.members` — discovery read-only.
- Integration connections: `ownerType 'user'|'org'`. Connection org: tạo/rotate/xóa cần org admin; org member thấy trong list; chỉ bind được vào project **cùng org** (project admin bind).

## 5. Thiết lập user mới

- Signup → tự có personal org (owner).
- Làm chung: được add vào **org** (thấy connection chung; admin org thấy mọi project) hoặc mời vào **project** lẻ (role admin/member/viewer).
- AI tool → tạo PAT ở `/settings`; cần thao tác quản trị → thêm scope `admin`.
- Admin REST instance → thêm email vào `ADMIN_EMAILS` + redeploy.

## 6. Mapping thuật ngữ

| Trong code | Nghĩa |
|---|---|
| `organizations` / `organizationMembers` | org + role org |
| `projects.org_id` / `created_by` | org chứa project / audit người tạo |
| `projectMembers` | role project tường minh (admin/member/viewer) |
| `lib/authz.ts` | module phân quyền duy nhất (effectiveProjectRole, assertProjectRole, assertOrgRoleOnProject, loadVisibleProjectIds) |
| `ADMIN_EMAILS` | admin REST instance (config khi deploy) |
