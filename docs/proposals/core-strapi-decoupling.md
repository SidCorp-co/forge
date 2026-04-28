---
name: Clean-break to packages/core
description: Skip Strapi entirely. Build packages/core from scratch, point all clients at it, delete forge/strapi in one shot. No parity, no dual-run, no migration.
type: proposal
---

# Proposal: Clean-break to `packages/core`

- **Status:** Draft (companion to [RFC 0002](../rfcs/0002-replace-strapi-with-hono-drizzle.md))
- **Date:** 2026-04-23
- **Author:** @junixlabs

## Decision

**Bypass Strapi entirely. Do not migrate. Do not run both backends. Do not write contract tests against the old API.**

Build `packages/core` as a fresh, purpose-shaped service. When it is feature-complete, all clients are pointed at it in one PR, and `forge/strapi/` is deleted in the same PR. The internal alpha deployment is wiped and recreated on `core` from empty.

This is allowed because:
- No external users.
- No production data worth preserving.
- The Strapi schema is not the schema we want — copying it would cement the wrong shape.

## Target architecture

```
┌──────────────┐  ┌──────────────┐
│   web (Next) │  │  dev (Tauri) │       app (Expo) — paused, ADR 0009
└──────┬───────┘  └──────┬───────┘
       │ REST + WS              │
       └────────────┬───────────┘
                    ▼
          ┌──────────────────┐
          │   packages/core     │  Hono · Drizzle · pg-boss · ws · MCP
          │   (single proc)  │
          └────────┬─────────┘
                   │
          ┌────────▼─────────┐
          │  Postgres        │  data + jobs (pg-boss) + vectors (pgvector)
          └──────────────────┘
```

One backend. One process. **One database** — Postgres carries data, jobs (pg-boss), and embeddings (pgvector). No Strapi, no Qdrant, no Redis. Mobile (`packages/app/`) is paused per [ADR 0009](../decisions/0009-mobile-app-paused-for-v0x.md) and is not a client of `core` in v0.x.

### Surface

| Path | Purpose |
|------|---------|
| `/api/*` | REST (projects, issues, comments, devices, jobs, agents, auth) |
| `/ws` | WebSocket, room-scoped per principal |
| `/mcp` | MCP server (Streamable HTTP) — same handlers as REST |
| `/health` | liveness + queue + ws status |

Admin UI is not part of `core` — it lives at `/admin` in `packages/web/` and uses the same REST.

### Module shape (inside `packages/core/`)

```
packages/core/
  migrations/         drizzle-kit generated SQL (top-level per drizzle convention)
  drizzle.config.ts   points migrations out → ./migrations
  src/
    index.ts          Hono app, signal handlers
    env.ts            Zod-validated config; fail-fast on boot
    db/
      client.ts       Drizzle singleton
      schema.ts       All tables (single source of truth)
    auth/
      jwt.ts          jose
      password.ts     argon2
      policy.ts       assertUserIsProjectMember(...) etc — every route calls one
    api/
      <domain>/       routes.ts + handlers.ts per domain
    ws/
      server.ts       attachWs/closeWs
      rooms.ts        RoomManager
    queue/
      boss.ts         pg-boss singleton
      dispatcher.ts   job → device fanout
    vectors/
      client.ts       pgvector via Drizzle (same Postgres connection)
      embeddings.ts   embed + upsert + similarity search
    mcp/
      server.ts       mounts /mcp
      tools/<domain>.ts thin wrappers over api/ handlers
```

Routes never call DB directly without going through a `policy.ts` assertion first. This is the architectural rule that closes the audit findings (RFC 0002 §Motivation #6) by construction.

## Build sequence (Phase 2)

Each phase ends in a working `core` that runs locally and in CI. Strapi is **not touched** until Phase 2.5.

| Phase | Scope | Done when |
|-------|-------|-----------|
| **2.0** ✅ | Workspaces, skeleton, db client, queue, ws scaffold, docker-compose, CI | `pnpm dev` boots `core`; `/health` returns ok |
| **2.1** | Env loader, base schemas (users, projects, members), error handling, graceful shutdown, MCP skeleton, test infra | Auth-less REST + ws + mcp respond |
| **2.2** | Auth (JWT, email verify, sessions), policy module, projects + issues + comments + attachments | A user can sign in, create a project, file an issue via REST |
| **2.3** | Devices, jobs, JobEvents, pg-boss dispatcher, ws fanout, agents, skills, chat | A device can claim a job, post events, broadcast to subscribed clients |
| **2.4** | MCP tools for every domain | Claude Code talks to `core` over MCP and exercises all CRUD |
| **2.5** | **The flip** (see below) | `forge/strapi/` deleted; clients on `core` |
| **2.6** | `/admin` routes in `packages/web/` | User/project/device/audit admin functional |

Phases run sequentially. No phase depends on Strapi state.

## Phase 2.5 — the single flip PR

One PR. Reviewed as one. Merged as one.

1. Add `FORGE_CORE_URL` to `web/.env.example` and `dev/.env.example`. Remove `STRAPI_URL` from all clients (including `app/`, even though `app/` is paused per ADR 0009).
2. Replace the API base in each active client's HTTP client with `FORGE_CORE_URL`. (One constant per client. `app/` is not touched beyond env cleanup.)
3. Replace the WebSocket URL with `${FORGE_CORE_URL}/ws`.
4. Delete `forge/strapi/` in its entirety.
5. Remove the `strapi` and `qdrant` services from `docker-compose.yml`. Add the `pgvector` extension to the Postgres init (`CREATE EXTENSION IF NOT EXISTS vector;` in a Drizzle migration).
6. Remove the Strapi job from `.github/workflows/ci.yml`.
7. Update `jarvis-agents/CLAUDE.md`, `forge/strapi/CLAUDE.md` (delete), and `docs/architecture/system-overview.md`.
8. Wipe and recreate the internal alpha deployment from empty.

Acceptance: `git grep -i strapi` after this PR returns matches **only** in `docs/rfcs/0002-*` and `docs/decisions/0002-*` (historical record).

## What we explicitly do NOT do

- ❌ **Contract tests against Strapi.** The old API is not the spec. RFC 0002 is.
- ❌ **Per-domain client switches.** No state where web is on `core` and dev is on `strapi`.
- ❌ **Schema migration scripts.** Drizzle schema is authored fresh; migrations start from `0000_init.sql`.
- ❌ **Data export from Strapi.** Internal alpha is test data; recreating it is faster than migrating it.
- ❌ **Strapi compatibility shims in `core`.** No `/api/v1` prefix to mimic Strapi paths, no Strapi response envelopes (`{ data, meta }`). REST shape is whatever serves the clients best.
- ❌ **Feature flags routing some calls to Strapi during cutover.** There is no cutover window — there is a flip.

## Risk and rollback

The only risky moment is Phase 2.5. Before merge:

- All Phase 2.4 e2e tests must be green against a `core`-only preview.
- Internal alpha is recreated on a staging host first; team uses it for ≥3 working days.
- The Phase 2.5 PR is a single commit so `git revert` restores Strapi end-to-end.

After merge, rollback means restoring `forge/strapi/` from git and reverting client envs. The recreated internal alpha data is lost on rollback — accepted, since it's test data, and the alternative (carrying Strapi forward) defeats the whole effort.

## Related decisions

- [ADR 0009](../decisions/0009-mobile-app-paused-for-v0x.md) — `packages/app/` is not a Phase 2.5 client.
- [ADR 0010](../decisions/0010-clean-break-from-strapi.md) — formalizes the clean-break cutover model (no parity, single flip PR).
- [ADR 0011](../decisions/0011-pgvector-replaces-qdrant.md) — vector storage moves into Postgres `pgvector`, supersedes "Qdrant unchanged" in [ADR 0002](../decisions/0002-replace-strapi-with-hono-drizzle.md), [ADR 0006](../decisions/0006-pg-boss-for-job-queue.md), and [RFC 0002](../rfcs/0002-replace-strapi-with-hono-drizzle.md) §Stack.

## Resolved decisions

| # | Question | Decision | Rationale |
|---|---|---|---|
| **D1** | Drizzle migrations location | `packages/core/migrations/` (top-level) | Standard drizzle-kit convention; cleaner CLI ergonomics — no `--out` flag on every command. |
| **D2** | `packages/dev` local-Strapi mode | **Removed** in Phase 2.5. No `core` local-mode in v0.x. | Opt-in dev tooling with low usage; reintroducing later against `core` is cheaper than porting now. |
| **D3** | `/admin` UI in `packages/web/` for Phase 2.5 | **Not required** for the flip. Operate via Drizzle Studio + REST during cutover week. Ship `/admin` in Phase 2.6. | Keeps Phase 2.5 to a single PR; `/admin` work doesn't gate the Strapi deletion. |
| **D4** | pgvector index type | **`hnsw`** | Embedding corpus is small in v0.x; recall matters more than build speed for agent context retrieval. Re-evaluate if corpus crosses ~1M vectors. |

D4 has been promoted to **[ADR 0011](../decisions/0011-pgvector-replaces-qdrant.md)** (accepted 2026-04-23). The cutover model itself (clean break, no parity, single flip PR) is **[ADR 0010](../decisions/0010-clean-break-from-strapi.md)**. D1–D3 are execution-scoped and live and die with this proposal.

## When this proposal retires

When Phase 2.5 merges, this file is deleted. Its content is no longer a proposal — it is the system. The system overview in `docs/architecture/system-overview.md` becomes the canonical description.
