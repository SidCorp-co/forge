# Jarvis Agents

Project management + AI agent platform.

## Before you start a task — read first

| You are about to... | Required reading |
|---|---|
| Touch `forge/core/` (the new Hono+Drizzle backend) | [docs/rfcs/0002](docs/rfcs/0002-replace-strapi-with-hono-drizzle.md) + [docs/proposals/core-strapi-decoupling.md](docs/proposals/core-strapi-decoupling.md) |
| Add or change anything in `forge/strapi/` | **STOP** — Strapi is being removed (RFC 0002). Ask before extending. |
| Touch `forge/app/` (mobile) | **STOP** — paused per [ADR 0009](docs/decisions/0009-mobile-app-paused-for-v0x.md). Ask before changing. |
| Change auth, queue, vector storage, license, or any cross-cutting choice | Find the matching ADR in [docs/decisions/](docs/decisions/). Do not contradict. |
| Build a feature in an existing module (issues, agents, devices, chat, skills, memory) | The matching `docs/modules/<name>/README.md` |
| Add a new cross-module flow | [docs/architecture/cross-module-flows.md](docs/architecture/cross-module-flows.md) |
| Propose a significant change | Open a proposal in [docs/proposals/](docs/proposals/), upgrade to RFC if it crosses APIs |

If a doc disagrees with the code, **trust the code, then propose a doc fix** — do not silently re-derive.

## Current state (2026-04)

- **Backend:** `forge/core` (Hono + Drizzle + pg-boss + ws + MCP). Single process, single Postgres for data + jobs + vectors (`pgvector`). See [RFC 0002](docs/rfcs/0002-replace-strapi-with-hono-drizzle.md) + [docs/proposals/core-strapi-decoupling.md](docs/proposals/core-strapi-decoupling.md).
- **`forge/strapi/`** — legacy package, scheduled for deletion at the Phase 2.5 flip PR. Do not add features, endpoints, or content types.
- **`forge/app/`** — paused per [ADR 0009](docs/decisions/0009-mobile-app-paused-for-v0x.md). No development.

## Packages

- **forge/core/** — Hono + Drizzle backend (the backend)
- **forge/web/** — Next.js 16 cloud UI
- **forge/dev/** — Tauri desktop app
- **forge/strapi/** — legacy, being deleted
- **forge/app/** — paused (ADR 0009)

`forge/core/`, `forge/web/`, `forge/dev/` join a pnpm workspace at `forge/`. Each other package is independent.

## Key Patterns

- TypeScript everywhere (Rust only for Tauri backend)
- React Query for server state; Zustand for client state (dev/app)
- WebSocket real-time broadcasts; room-scoped per principal in `core` (see [docs/architecture/websocket.md](docs/architecture/websocket.md))
- Feature modules organize by domain: `api.ts`, `types.ts`, `components/`, `hooks/`
- Bearer token in Authorization header; always use `apiClient`, never raw `fetch`
- ADRs are append-only — never edit a past decision; supersede with a new ADR

## Commands

| Package | Dev | Build | Test |
|---|---|---|---|
| core | `pnpm dev` | `pnpm build` | `pnpm test` |
| web | `pnpm dev` | `pnpm build` | `pnpm test` |
| dev | `pnpm tauri dev` | `pnpm tauri build` | `pnpm test` |
| strapi | — frozen — | — | — |
| app | — paused — | — | — |

## Documentation map

Full index at [docs/README.md](docs/README.md). Quick jumps:

- [docs/architecture/](docs/architecture/) — system overview, cross-module flows, websocket
- [docs/modules/](docs/modules/) — per-feature docs (issues-pipeline, agents-jobs, devices, chat, skills, memory-knowledge)
- [docs/decisions/](docs/decisions/) — ADRs (0001 device-runner … 0011 pgvector)
- [docs/rfcs/](docs/rfcs/) — accepted RFCs (0002 Strapi replacement)
- [docs/proposals/](docs/proposals/) — in-flight proposals (Strapi cutover, cost-aware routing)
- [docs/system.graph.json](docs/system.graph.json) — machine-readable system map (validated against [schema](docs/system.graph.schema.json))
- [docs/ROADMAP.md](docs/ROADMAP.md) — what ships next
