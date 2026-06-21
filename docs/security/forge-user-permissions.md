# User resources & permissions

What a user owns, what they can access, who counts as admin.

## 1. Ownership model

Every project belongs to exactly **one Organization** (`projects.org_id` NOT NULL). Each user gets a **personal org** at signup (migration 0106 backfilled existing users). `projects.created_by` is audit-only — carries no permission.

```
User ──(org role)──> Organization ──> Project ──> Issue / Run / Session / Connection-binding
User ──(project role)────────────────^
```

## 2. Two role tiers + one instance layer

| Tier | Roles | Meaning |
|---|---|---|
| **Org** | `owner` > `admin` > `member` | owner/admin: implicit **project admin** on EVERY org project + manage org members + org-owned connections; `member`: may create projects + use org connections — does NOT see projects automatically |
| **Project** | `admin` > `member` > `viewer` | admin: members/labels/runners/skills/bind connections; member: issues/runs/comments/chat; viewer: read-only |
| **Instance** | `ADMIN_EMAILS` env | gates REST `/api/admin/*` only (self-host operator) — tenant-independent |

**Single formula** (`packages/core/src/lib/authz.ts`):
`effectiveProjectRole = max(projectMembers.role, org owner/admin → 'admin')`. Every REST + MCP + WS gate goes through this module.

Legacy "project owner" gates (settings PATCH, DELETE, archive, pipeline-config) = **org owner/admin** (`assertOrgRoleOnProject`) — an invited project admin is NOT enough.

## 3. Four entry doors

| Door | Key | Notes |
|---|---|---|
| Web / Mobile | `forge_auth` cookie (JWT) | full per-role access |
| Desktop (Forge Dev) | Device token | acts as the user (no scopes) |
| Script / AI tool | PAT (`/settings`) | user rights ∩ `projectIds` allowlist ∩ **scopes** |

**PAT scopes** (`read` / `write` / `admin`): admin-grade MCP mutations (`forge_skills` update/push, `forge_projects.update/.archive`, `forge_config`…) require `admin` (`assertPrincipalIsAdmin`). Pre-0106 PATs were grandfathered `admin`; new PATs default `read,write`. Threat analysis: [mcp-threat-model.md](mcp-threat-model.md).

## 4. Key surfaces

- REST `/api/orgs` — org + member CRUD (existing accounts are added directly by email; for an unknown email, `POST /:orgId/members` falls back to `issueOrgInvitationToken` → `/api/org-invitations` (`org_invitations` table) to send an email-token org invitation. Project invites also use email tokens).
- `POST /api/projects` + `forge_projects.create` — optional `orgId` (defaults to personal org); creator gets project role `admin`.
- MCP `forge_orgs.list` / `forge_orgs.members` — read-only discovery.
- Integration connections: `ownerType 'user'|'org'`. Org connections: create/rotate/delete needs org admin; org members see them in lists; bindable only to projects **in the same org** (by a project admin).

## 5. New-user setup

- Signup → personal org (owner) auto-created.
- Collaboration: add to an **org** (sees shared connections; org admin sees all projects) or invite to a single **project** (admin/member/viewer).
- AI tooling → create a PAT at `/settings`; admin operations need the `admin` scope.
- Instance REST admin → add email to `ADMIN_EMAILS` + redeploy.

## 6. Code mapping

| In code | Meaning |
|---|---|
| `organizations` / `organizationMembers` | org + org role |
| `projects.org_id` / `created_by` | owning org / creator audit |
| `projectMembers` | explicit project role (admin/member/viewer) |
| `lib/authz.ts` | the only authz module (effectiveProjectRole, assertProjectRole, assertOrgRoleOnProject, loadVisibleProjectIds) |
| `ADMIN_EMAILS` | instance REST admin (deploy config) |
