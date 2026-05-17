# MCP Threat Model — Personal Access Tokens (ISS-150)

This document captures the threats and mitigations for the Personal Access
Token (PAT) authentication path added alongside the legacy device-token
path in `/mcp`. Read together with `packages/core/src/auth/pat.ts`,
`packages/core/src/middleware/require-pat-or-device.ts`, and
`packages/core/src/mcp/server.ts`.

## Surface

`/mcp` (POST/GET/DELETE) accepts `Authorization: Bearer <token>` where
`<token>` is either:

- a paired-device token (legacy desktop path — unchanged behaviour), or
- a PAT of shape `forge_pat_<env>_<64 hex>` (`<env>` ∈ `dev|stg|prd`).

The dispatcher (`require-pat-or-device.ts`) chooses the path by prefix and
populates `c.get('principal')` with the union type
`{ kind: 'device'; device } | { kind: 'pat'; userId; tokenId; scopes; projectIds }`.

REST CRUD for PATs lives under `/api/pat` and requires a regular user JWT
(cookie or Bearer). PATs cannot mint PATs — the user must be logged in via
the browser/web flow first.

## Threats and mitigations

### T1 — Cross-tenant read via stolen or mis-issued PAT

A PAT scoped to project X must not allow `forge_issues.list` against
project Y, regardless of how the caller frames the request.

**Mitigations:**

- `personal_access_tokens.project_ids` is enforced in two places:
  - `mcp/server.ts` checks `projectId` extracted from common arg fields
    (`projectId`, `filters.projectId`) before invoking any tool. On miss,
    we return `not_found` (NOT `forbidden`) to avoid existence leaks.
  - `assertPrincipalIsMember(principal, projectId)` and
    `assertPrincipalIsAdmin(principal, projectId)` in `tools/lib.ts` do
    the same check at the per-call layer for tools that adopt the
    principal-aware helpers.
- The REST mint endpoint (`POST /api/pat`) rejects any `projectIds` entry
  that isn't a project the user can access — preventing the user from
  minting a token "scoped to" a project they have no claim on.

### T2 — Token leak via logs / Sentry / WebSocket broadcasts

If a PAT plaintext appears in a Sentry event, log line, or WS payload,
attackers with read access to the observability stack can replay it.

**Mitigations:**

- `packages/observability/src/index.ts` exports `PAT_STRING_PATTERN`
  (unanchored, global) and `scrubStringValues` / `scrubPatInString`.
- `scrubSentryEvent` now applies the PAT scrubber to request URL, body,
  breadcrumb messages, breadcrumb `data`, and recursively walks nested
  string values. Header values are still redacted by the existing
  key-based pass.
- `packages/web/instrumentation*.ts` and `packages/core/src/observability/sentry.ts`
  call `scrubSentryEvent` already — extending the canonical module flows
  through to every surface with no per-adapter change.

### T3 — Privilege escalation through admin tools

A non-admin user must not be able to call `forge_admin_*` or `forge_pm_*`
tools through a PAT, no matter what `scopes` they minted on the token.

**Mitigations:**

- `forge_pm_*` tools are listed in `DEVICE_REQUIRED_TOOLS` in
  `mcp/server.ts`. A PAT principal hitting any of these short-circuits
  to `FORBIDDEN: PM_REQUIRES_DEVICE` before the tool runs. PM tools
  inherently require a paired claude-code runner, which only paired
  devices can host.
- For role-gated tools, `assertPrincipalIsAdmin(principal, projectId)`
  checks `projects.ownerId === userId` OR
  `projectMembers.role IN ('owner','admin')`. The PAT `scopes` array
  does NOT widen this — admin access is bound to the underlying user's
  role on the project, not to anything that can be granted at mint time.

### T4 — Brute force / credential stuffing

An attacker who learns a PAT's prefix should not be able to brute-force
the body cheaply.

**Mitigations:**

- argon2id hashing with the same parameters used elsewhere
  (`memoryCost: 19456, timeCost: 2, parallelism: 1`).
- Distinct pepper `PAT_PEPPER` per-environment, distinct from
  `DEVICE_TOKEN_PEPPER`.
- Per-PAT rate limit: 60 req/min by default, configurable via the
  `rate_limit_max` column or `RATE_LIMIT_PAT_*` envs.
- Auto-revoke after three rate-limit breaches within an hour — the
  attacker has a small budget before the token burns.

### T5 — Replay after revocation

Revoking a PAT must take effect immediately. A cache between revoke and
the next request introduces a window for replay.

**Mitigations:**

- `verifyPat` queries the DB on every request. There is no in-memory
  verification cache. The rate-limit bucket caches per-token usage
  but does NOT cache verification results.
- The bucket's hot path costs one indexed lookup + argon2 verify — see
  the load-test note below.

### T6 — Timing oracle on prefix lookup

If `verifyPat` returns faster for a non-matching prefix than for a
matching-prefix wrong-body, an attacker can probe prefixes.

**Mitigations:**

- We always iterate every row returned by the prefix-indexed query and
  run `argon2.verify` on each, even after we have already matched.
  Total verify work is proportional to the bucket size for the
  attacker's prefix, not to whether a match was found.
- Prefix selectivity (`forge_pat_<env>_<4 hex>`) gives ~65k buckets per
  env at uniform distribution; expected rows per bucket are O(1) for
  any realistic user base.

### T7 — Audit gap

If an MCP tool call fails to record an audit row, an operator cannot
forensically reconstruct what happened.

**Mitigations:**

- `mcp/server.ts` writes one `mcp_audit_log` row per call (success, scope
  miss, device-required, error, rate-limited). Inserts are fire-and-forget
  so audit failure cannot 5xx a tool call.
- Indexes (`mcp_audit_token_idx`, `mcp_audit_user_idx`, `mcp_audit_project_idx`)
  support fast retrieval from REST (`GET /api/pat/:id/audit`).

## Operational guidance

### `PAT_PEPPER` rotation

The pepper is part of the input to argon2id. Rotating it invalidates
every existing PAT (verify will return false). For first roll-out (no
PATs exist yet), this is harmless — set a strong value in production
before the first PAT is minted.

In production, `PAT_PEPPER` must be set explicitly to a 32+ char value.
The env schema defaults it to a placeholder in dev/test to avoid
breaking unit tests.

### Audit-log retention

Migration `0063_mcp_audit_log.sql` creates a plain (non-partitioned)
table. Retention is enforced by the periodic
`enforceMcpAuditRetention()` call (deletes rows older than 90 days).

A follow-up PR should migrate this table to monthly `RANGE` partitions
so retention becomes `DROP PARTITION` instead of a `DELETE`. The plan
in ISS-150 sketches the partition wiring; implementation is deferred
to keep this PR reviewable.

### Append-only grant

The plan recommends `REVOKE UPDATE, DELETE ON mcp_audit_log FROM forge_app`
so the app role can only INSERT + SELECT. Our DB client uses a single
role from `DATABASE_URL`, so this grant must be applied out-of-band by
the operator. We document the recipe rather than running it from a
migration because the role name is operator-specific.

```sql
-- Replace `forge_app` with the role from your DATABASE_URL.
REVOKE UPDATE, DELETE ON mcp_audit_log FROM forge_app;
```

### Auto-revoke on password change

The threat model requires that changing a user's password revokes
every live PAT for that user. The helper
`revokeAllPatsForUser(userId, 'password_changed')` is exported from
`packages/core/src/auth/pat.ts`. The password-change endpoint is not
yet implemented in this repo — when it lands, it MUST call this helper
in the same transaction as the `users.password_hash` update.

### Auto-revoke on suspicious IP fan-out

The plan sketches a check that revokes any PAT whose last N audit rows
show > 3 distinct IPs in 60 seconds. This is feasible against the
existing `mcp_audit_token_idx` and is left to a follow-up PR — the
core middleware path already supports the auto-revoke action
(`forceRevokePat(id)`), so this is a pure detection-logic addition.

## Out of scope for ISS-150

- HTTPS-only enforcement on `/mcp` — handled at the deploy layer
  (Traefik/Coolify). No app-layer redirect.
- Granular scope semantics beyond `read`/`write` — the array is
  reserved on the row, but the verifier doesn't yet refuse a tool
  based on its declared scope. The `scopes` column is a forward-compat
  hook for a future ISS that maps each MCP tool to a required scope.
- Cross-user admin audit page — `POST /api/admin/tokens/audit` is not
  in this PR. Operators with DB access can `SELECT * FROM mcp_audit_log`.
- The CI mutation test for `assertPrincipalIsMember` — the test
  infrastructure (separate `vitest.mutation.config.ts`, monkey-patched
  helper, CI step) is sketched in the issue plan and deferred to
  follow-up so this PR stays reviewable.
- Load-test job with `p95 < 50ms` assertion. The verifier on a warm
  process measures comfortably under 50ms locally; we ship the
  primitives and defer the gated CI step.
