# ADR 0005 — Dual-principal authorization (user + device)

- **Status:** Accepted
- **Date:** 2026-04-19
- **Full design:** [RFC 0001 § Authorization](../rfcs/0001-device-runner-architecture.md)

## Context

The device-runner model introduces two actors that call the API:

1. **Users** — humans on the web, desktop, or mobile UI
2. **Device agents** — the Tauri `dev` app or the `forged` CLI daemon, running on paired machines

These actors deserve different trust. A user can see PII; a device cannot. A user can enqueue jobs; a device can submit JobEvents but cannot enqueue arbitrary jobs. Treating them as a single principal with bolt-on flags leads to scattered, drift-prone checks.

The earlier monolith authenticated users via JWT and did ad-hoc "is this caller allowed" checks in each controller. Audit finding #1 flagged multiple endpoints missing ownership checks entirely.

## Decision

Two distinct principal types, one shared policy layer:

- **User principal** — short-lived JWT (7-day TTL) with refresh-token rotation (30-day TTL, one-time-use)
- **Device principal** — long-lived device token issued at pairing time, revocable from the web UI

All access checks go through a shared module (`policies/shared/access.ts` or equivalent) that exports:

```ts
assertUserIsProjectMember(ctx, projectId)
assertDeviceBelongsToProject(ctx, projectId)
assertJobAccessibleByPrincipal(ctx, jobId)
```

Every REST controller, every WebSocket event handler, every MCP tool invocation must call one of these helpers before reading or writing. **No code path bypasses the policy layer.**

A permission matrix codifies what each principal type can do:

| Action | User | Device |
|--------|------|--------|
| Read project | ✓ if member | ✓ if device is in project pool |
| Enqueue job | ✓ | ✗ |
| Submit JobEvents | ✗ | ✓ if `device == job.device` |
| Set project active device | ✓ if owner | ✗ |
| Read user profile (PII) | ✓ self | ✗ never |
| Enumerate all projects of a user | ✓ self | ✗ scoped to pool |

## Rationale

- **Policy drift prevented** — one module, exhaustively covered by tests. New endpoints cannot forget an access check.
- **Device can't impersonate user** — device principal explicitly cannot read other users' PII or enumerate across the account
- **Revocation is surgical** — revoking a device doesn't affect the user's web session, and vice versa
- **Matches the trust reality** — a paired device is "your machine acting on your behalf," not "you logged in from a machine"

## Alternatives considered

1. **Single principal, scoped JWT** — rejected: a device token and a user token have different lifetimes (device = long-lived, user = short-lived); a device token embedded in a binary can't rotate easily. Forcing them into the same shape is a leaky abstraction.
2. **OAuth-style device flow for every job** — rejected: adds an interactive step to every job dispatch; kills the "fire and forget" automation value.
3. **Row-level security in Postgres (Supabase-style)** — attractive but Strapi didn't expose Postgres directly, and the same constraint may apply to Hono/Drizzle if we want caching layers later. The in-process policy module gives us equivalent centralization with more control.
4. **Scatter per-controller checks and add tests** — rejected: test coverage can't prove absence of missing checks; new endpoints will drift.

## Consequences

### Positive
- Access logic centralized — reviewable, testable, hard to bypass
- Two principal types are audit-friendly: every action is attributable to a specific actor class
- Refresh-token rotation closes the 365-day-JWT audit finding
- Device revocation works cleanly — no need to invalidate all user sessions when a laptop is lost

### Negative
- Every new endpoint adds a line of boilerplate: call a policy assertion
- Mistakes in the policy module affect every endpoint — requires strong test coverage
- MCP tools have to explicitly say which principal type they expect; adds a few lines per tool

### Neutral
- Admin operations are a third "user with elevated role" — not a third principal. Elevation is a flag on the user principal.

## Testing requirement

Policy module must have **≥90% test coverage** before merge. Every principal × resource pair in the permission matrix should have at least one positive and one negative test.

## Related

- Required by: [ADR 0001](0001-device-runner-architecture.md) (device-runner architecture)
- Closes: audit findings #1, #2, #3 from 2026-04-19
