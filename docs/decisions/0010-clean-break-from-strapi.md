# ADR 0010 — Clean break from Strapi to `packages/core`

- **Status:** Implemented
- **Date:** 2026-04-23
- **Implemented:** 2026-04-24
- **Full design:** [RFC 0002](../rfcs/0002-replace-strapi-with-hono-drizzle.md), [proposals/core-strapi-decoupling.md](../proposals/core-strapi-decoupling.md)
- **Supersedes (in spirit):** none — formalizes the cutover model that ADR 0002 left open.

## Context

[ADR 0002](0002-replace-strapi-with-hono-drizzle.md) decided **what** to build (a Hono + Drizzle service, `packages/core`) and **why** (workload shape, memory footprint, upgrade treadmill, OSS-contributor friction). It did **not** decide **how** the existing Strapi-dependent codebase moves to the new service.

Two cutover models were possible:

1. **Parity + dual-run** — build `packages/core` to match Strapi's API exactly, run both backends in production, switch clients per-domain behind feature flags, write contract tests asserting equivalence.
2. **Clean break** — build `packages/core` from scratch with the API shape we actually want, point all clients at it in a single PR, delete `forge/strapi/` in the same PR.

Without a decision, work drifted toward (1) — agents added "compatibility" thinking, contract-test scaffolding, dual-write hooks. This created the worst-of-both: longer Phase 2, half-Strapi-shaped `core`, and no clear "Strapi is gone" moment.

The internal alpha has no external users, no production data worth preserving, and no contractual API compatibility obligations. The Strapi schema is not the schema we want.

## Decision

**Clean break.** `packages/core` is built fresh against the API shape that serves the clients best. There is no parity gate, no dual-run window, no contract tests against the legacy Strapi API. When `packages/core` reaches feature-completeness:

- All clients (`web/`, `dev/`) are pointed at `packages/core` in one PR.
- `forge/strapi/` is deleted in the same PR.
- The internal alpha deployment is wiped and recreated empty on `packages/core`.
- No Strapi service in `docker-compose.yml`, no `STRAPI_URL` env vars, no Strapi response envelope (`{ data, meta }`) compatibility shims.

`forge/strapi/` is **frozen** from the date of this ADR: bug fixes only, no new content types or endpoints.

## Rationale

- **No users to migrate.** The only data is internal test data; recreating is faster than migrating.
- **The Strapi API shape is not the target.** Mimicking it would cement the wrong contract and force refactoring later.
- **Parity is expensive and never finishes.** Contract tests, dual-write hooks, and per-domain feature flags add weeks of work whose only deliverable is "you can't tell which backend you're talking to" — not a product feature.
- **Clean-break has a single failure mode (the flip PR) instead of N drift modes.** A single revert restores Strapi end-to-end; a partially-flipped state has no clean rollback.
- **OSS launch story is sharper.** "We rebuilt the backend" beats "we have a slow migration in progress."

## Alternatives considered

1. **Parity + dual-run (rejected, see Context).** Worst-of-both: longer timeline, no clean cutover moment, half-shaped `core`.
2. **Migrate the Strapi schema with `drizzle-kit pull` and adapt.** Rejected — the Strapi-shaped schema is exactly what we're trying to escape.
3. **Keep Strapi for the admin UI, run `packages/core` for everything else.** Rejected — two backends double operational surface for self-hosters; admin UI is small enough to ship in `packages/web/` (Phase 2.6).
4. **Defer the cutover to v0.x+1.** Rejected — every week Strapi stays adds drift, contributor confusion, and audit-finding workarounds.

## Consequences

### Positive

- Single decision rule for every Phase 2 PR: "Does this depend on Strapi? If yes, defer until after the flip."
- Zero ongoing dual-write or compatibility cost.
- Phase 2.5 = one PR, one revert, one wipe-and-recreate.
- `packages/core` API shape is owned by us, not inherited.

### Negative

- Internal alpha data is lost on cutover (accepted — test data, ~20 SidCorp engineers, recreatable in <1 day).
- The flip PR is large by necessity (touches all clients + deletes a package). Compensated by being a single atomic revert target.
- Loss of Strapi admin UI for ~1 week of cutover before Phase 2.6 ships `/admin` in `packages/web/`. Mitigation: Drizzle Studio + REST during the gap.

## Implementation notes

- Flip executed via ISS-219 (Phase 2.8-F1): single PR containing `forge/strapi/` deletion + client repointing + docker-compose finalization. No dual-run window used, no contract-test scaffolding written.
- Archive preserved at `legacy/strapi-v0` tag and branch; `git ls-tree legacy/strapi-v0 forge/strapi` remains non-empty for recoverability.
- Internal alpha deployment wiped and recreated empty on `packages/core` per the ADR's acceptance of data loss.
- `packages/app/` received the `STRAPI_URL` cleanup (rename to `API_ORIGIN`, `strapiMediaUrl` → `mediaUrl`) with no other functional changes, per the "Affects" clause below.
- `/admin` in `packages/web/` shipped in Phase 2.6; Drizzle Studio covered the pre-2.6 gap as planned.

## Related

- Driven by: [ADR 0002](0002-replace-strapi-with-hono-drizzle.md) (decided to replace Strapi; this ADR decides how)
- Bound to: [ADR 0011](0011-pgvector-replaces-qdrant.md) (vector storage cutover happens in the same flip PR)
- Affects: [ADR 0009](0009-mobile-app-paused-for-v0x.md) — `packages/app/` is not a Phase 2.5 client; its `STRAPI_URL` cleanup happens at the flip but no functional changes
- Cutover plan: [proposals/core-strapi-decoupling.md](../proposals/core-strapi-decoupling.md) (execution detail)
