# MCP Threat Model — Personal Access Tokens (ISS-150)

Threats + mitigations for the PAT auth path alongside legacy device-token on `/mcp`. Read with `packages/core/src/auth/pat.ts`, `packages/core/src/middleware/require-pat-or-device.ts`, `packages/core/src/mcp/server.ts`.

## Surface

- `/mcp` (POST/GET/DELETE) accepts `Authorization: Bearer <token>`, either a paired-device token (legacy desktop, unchanged) or a PAT `forge_pat_<env>_<64 hex>` (`<env>` ∈ `dev|stg|prd`).
- Dispatcher (`require-pat-or-device.ts`) picks path by prefix, sets `c.get('principal')` = `{ kind: 'device'; device } | { kind: 'pat'; userId; tokenId; scopes; projectIds }`.
- PAT CRUD under `/api/pat`, requires user JWT (cookie/Bearer). PATs cannot mint PATs — browser/web login required first.

## Threats and mitigations

### T1 — Cross-tenant read via stolen or mis-issued PAT

PAT scoped to project X must not allow `forge_issues.list` against project Y, however framed.

- `personal_access_tokens.project_ids` enforced in two places:
  - `mcp/server.ts` checks `projectId` from common arg fields (`projectId`, `filters.projectId`) before any tool. On miss returns `not_found` (NOT `forbidden`) to avoid existence leaks.
  - `assertPrincipalIsMember(principal, projectId)` / `assertPrincipalIsAdmin(principal, projectId)` in `tools/lib.ts` do the same per-call for principal-aware tools.
- Mint endpoint (`POST /api/pat`) rejects any `projectIds` entry the user can't access — can't scope a token to an unclaimed project.

### T2 — Token leak via logs / Sentry / WebSocket broadcasts

PAT plaintext in a Sentry event, log line, or WS payload is replayable by observability-stack readers.

- `packages/observability/src/index.ts` exports `PAT_STRING_PATTERN` (unanchored, global) + `scrubStringValues` / `scrubPatInString`.
- `scrubSentryEvent` applies the PAT scrubber to request URL, body, breadcrumb messages, breadcrumb `data`, and recursively nested strings. Header values still redacted by existing key-based pass.
- `packages/core/src/observability/sentry.ts` is the only surface that calls `scrubSentryEvent` today (the canonical scrubber module). The retired web-v1 `packages/web/instrumentation*.ts` also called it, but the current `packages/web-v2` has no Sentry client wiring yet (no `instrumentation*.ts`, no Sentry dependency) — so when web Sentry is reinstated it must reuse this same scrubber.

### T3 — Privilege escalation through admin tools

Non-admin user must not call admin-gated tools (e.g. `forge_runners`) or device-required PM tools via PAT, whatever `scopes` they minted.

- The PM dispatcher `forge_project_pm` (with legacy `forge_pm.*` shims kept for back-compat) is device-required: a PAT principal short-circuits to `FORBIDDEN: PM_REQUIRES_DEVICE` before run. PM tools need a paired claude-code runner, hostable only by paired devices.
- Role-gated tools: `assertPrincipalIsAdmin` (`tools/lib.ts`) resolves the EFFECTIVE project-admin role via `lib/authz.ts` (explicit `project_members.role='admin'` OR org owner/admin derivation), and for PAT principals ALSO requires the `admin` scope. PAT `scopes` does NOT widen the role — admin access binds to the user's effective project role, not anything granted at mint.
- `forge_runners` (the admin-gated fleet tool) calls `assertPrincipalIsAdmin(principal, projectId)` and refuses non-admins. `forge_collaborators` / `forge_ops_health` are read-only discovery tools scoped by `loadVisibleProjectIdsForPrincipal` (NOT admin-gated) — they only return data for projects the principal can already see. There is no system-wide/CEO admin and no cross-tenant escalation path: a PAT cannot reach a project outside its `project_ids`, whatever its `scopes`.

### PAT scopes

`scopes` column is a JSONB array; three values honored at tool dispatch:

| scope | What it grants |
|---|---|
| `read` | All read-only project tools the underlying user can already reach. |
| `write` | Project-scoped mutating tools (issues/comments/etc.) the underlying user can already reach. |
| `admin` | Required (in addition to the user holding effective project-admin on the target project) to invoke any admin-gated tool (e.g. `forge_runners`) via a PAT. Only narrows a PAT relative to the user's existing project role — never grants cross-tenant access. Without effective project-admin the tool refuses. A PAT lacking this scope is rejected with `FORBIDDEN: this token lacks the admin scope`. |

- `mintPat` defaults to `['read', 'write']` when `scopes` omitted. `admin` must be explicitly requested, never auto-included.
- PAT creation doesn't check the user's project role (a non-admin may mint an `admin`-scoped token); the gate runs at tool time via `assertPrincipalIsAdmin` against the target project, so the token is unusable for admin-gated tools (e.g. `forge_runners`) without the role.

### T4 — Brute force / credential stuffing

Knowing a PAT prefix must not allow cheap body brute-force.

- argon2id hashing, same params as elsewhere (`memoryCost: 19456, timeCost: 2, parallelism: 1`).
- Distinct per-env pepper `PAT_PEPPER`, distinct from `DEVICE_TOKEN_PEPPER`.
- Per-PAT rate limit: 60 req/min default, configurable via `rate_limit_max` column or `RATE_LIMIT_PAT_*` envs.
- Auto-revoke after three rate-limit breaches within an hour.

### T5 — Replay after revocation

Revocation must take effect immediately; a cache opens a replay window.

- `verifyPat` queries the DB every request; no in-memory verification cache. Rate-limit bucket caches per-token usage but NOT verification results.
- Bucket hot path costs one indexed lookup + argon2 verify — see load-test note below.

### T6 — Timing oracle on prefix lookup

`verifyPat` returning faster for a non-matching prefix than a matching-prefix wrong-body lets an attacker probe prefixes.

- Always iterate every row from the prefix-indexed query and run `argon2.verify` on each, even after a match. Verify work ∝ bucket size for the attacker's prefix, not whether a match was found.
- Prefix selectivity (`forge_pat_<env>_<4 hex>`) gives ~65k buckets/env at uniform distribution; expected rows/bucket O(1) for any realistic user base.

### T7 — Audit gap

A missed audit row blocks forensic reconstruction.

- `mcp/server.ts` writes one `mcp_audit_log` row per call (success, scope miss, device-required, error, rate-limited). Inserts fire-and-forget so audit failure can't 5xx a call.
- Indexes (`mcp_audit_token_idx`, `mcp_audit_user_idx`, `mcp_audit_project_idx`) support fast retrieval from REST (`GET /api/pat/:id/audit`).

## Operational guidance

- **`PAT_PEPPER` rotation** — pepper feeds argon2id; rotating invalidates every existing PAT (verify returns false). Harmless at first roll-out (no PATs yet) — set a strong value before the first mint. In production `PAT_PEPPER` must be set explicitly to 32+ chars; env schema defaults to a placeholder in dev/test to avoid breaking unit tests.
- **Audit-log retention** — migration `0063_mcp_audit_log.sql` creates a plain (non-partitioned) table. Retention via periodic `enforceMcpAuditRetention()` (deletes rows older than 90 days). Follow-up PR should migrate to monthly `RANGE` partitions so retention becomes `DROP PARTITION` not `DELETE`; partition wiring sketched in ISS-150, deferred for reviewability.
- **Append-only grant** — plan recommends restricting the app role to INSERT + SELECT. DB client uses a single role from `DATABASE_URL`, so this grant is applied out-of-band by the operator (role name is operator-specific); recipe below rather than run from a migration.

```sql
-- Replace `forge_app` with the role from your DATABASE_URL.
REVOKE UPDATE, DELETE ON mcp_audit_log FROM forge_app;
```

- **Auto-revoke on password change** — changing a user's password must revoke every live PAT. Helper `revokeAllPatsForUser(userId, 'password_changed')` exported from `packages/core/src/auth/pat.ts`. Password-change endpoint not yet implemented; when it lands it MUST call this helper in the same transaction as the `users.password_hash` update.
- **Auto-revoke on suspicious IP fan-out** — plan sketches revoking any PAT whose last N audit rows show > 3 distinct IPs in 60 seconds. Feasible against `mcp_audit_token_idx`, left to a follow-up PR; core path already supports the auto-revoke action (`forceRevokePat(id)`), so this is pure detection logic.

## Out of scope

HTTPS enforcement on `/mcp` (deploy layer: Traefik/Coolify) · per-tool scope mapping (the `admin` scope IS enforced at dispatch — `assertPrincipalIsAdmin` throws `FORBIDDEN: this token lacks the admin scope` when a PAT lacks it; the `read`/`write` scopes are still not independently refused) · cross-user admin audit page (operators query `mcp_audit_log` directly) · mutation/load-test CI gates (deferred).
