# v0.1.0-rc.1 — Security audit closure

- **Release:** v0.1.0-rc.1
- **Audit source:** 2026-04-19 findings enumerated in [ADR 0001](../decisions/0001-device-runner-architecture.md) §Context
- **Follow-up tracking:** [SECURITY.md](../../SECURITY.md) (ongoing)
- **Date closed:** 2026-04-24

## Summary

All five findings from the 2026-04-19 audit are closed by construction in `forge/core`. The architectural split (device-runner + dual-principal auth + shared policy layer + room-scoped WebSocket + pgvector single-store) makes most findings not-applicable rather than patched. Evidence below references `main` @ post-ISS-221.

| # | Finding | Status | Evidence |
|---|---------|--------|----------|
| 1 | Row-level access checks missing on `issue` / `task` / `comment` controllers | Closed by construction | `forge/core/src/auth/policy.ts` exports `assertUserIsProjectMember` / `assertUserIsProjectOwner`; every REST route imports and calls these before DB access. Unit-tested in `forge/core/src/auth/policy.test.ts`. See [RFC 0002 §Single policy layer](../rfcs/0002-replace-strapi-with-hono-drizzle.md) and [docs/architecture/system-overview.md §Dual-principal authorization](../architecture/system-overview.md). |
| 2 | WebSocket broadcasts reaching every connected client with no project scoping | Closed by construction | `forge/core/src/ws/rooms.ts` + `broadcast-subscribers.ts` — sockets subscribe to `user:<id>` / `project:<id>` / `device:<id>` only at auth time; clients cannot request arbitrary rooms. Coverage in `forge/core/src/ws/rooms.test.ts`. See [docs/architecture/websocket.md](../architecture/websocket.md) and [docs/architecture/system-overview.md §WebSocket with room-scoped broadcasts](../architecture/system-overview.md). |
| 3 | `crossProjectAccess` MCP flag bypassing project boundaries | Closed — flag removed from the control plane | Every MCP tool call requires `projectId` and passes through `policy.assertUserIsProjectMember`. `grep -rn crossProjectAccess forge/core/` returns zero matches. See [docs/architecture/system-overview.md §MCP on the same data layer](../architecture/system-overview.md) and [RFC 0002](../rfcs/0002-replace-strapi-with-hono-drizzle.md). **Known residual (not a regression):** `forge/web/src/features/project/types.ts:149` retains the `crossProjectAccess?: boolean` field on the `Project` TypeScript type. No code reads or writes it; the field is vestigial and has no runtime effect. Scheduled for cleanup post-rc.1. |
| 4 | JWT TTL of 365 days stored in `localStorage` | Closed | Access JWT TTL is now 7 days, with refresh-token rotation and `httpOnly` cookies on web. See [ADR 0005 — Dual-principal auth](../decisions/0005-dual-principal-auth.md) and [docs/architecture/system-overview.md §Security boundaries](../architecture/system-overview.md). |
| 5 | Server simultaneously held Claude credentials, spawned subprocesses, and served HTTP | Closed by construction (device-runner split) | Control plane `forge/core` never sees Claude credentials; device agents hold them in OS keychain. See [ADR 0004 — No Claude credentials on server](../decisions/0004-no-claude-credentials-on-server.md) and [ADR 0001 — Device-runner architecture](../decisions/0001-device-runner-architecture.md). |

## Out of scope for v0.1.0-rc.1

- **Public third-party security review** — deferred to v0.5 per [ROADMAP.md §v0.5](../ROADMAP.md).
- **SIEM audit log export** — deferred to v0.5.
- **Performance benchmarks** — dropped from rc.1 (no production baseline; numbers would mislead). Revisit in v0.1.x post-release.
- **Cleanup of the vestigial `crossProjectAccess` field** in `forge/web/src/features/project/types.ts` — tracked as a follow-up; not user-facing, no runtime risk.

## Re-audit trigger

A new audit doc (`audit-v<next-release>.md`) opens for any of:

- New principal class (team, shared device — post-v0.4 per ROADMAP)
- New external data plane (e.g., Redis pub/sub in v0.5)
- New credential surface on the server
- Major third-party dependency change touching auth, WS, or MCP
