# Forge

Project management + AI agent platform.

## Before you start a task — read first

| You are about to... | Required reading |
|---|---|
| Touch `packages/core/` (the new Hono+Drizzle backend) | [docs/rfcs/0002](docs/rfcs/0002-replace-strapi-with-hono-drizzle.md) + [docs/proposals/core-strapi-decoupling.md](docs/proposals/core-strapi-decoupling.md) |
| Touch `packages/app/` (mobile) | **STOP** — paused per [ADR 0009](docs/decisions/0009-mobile-app-paused-for-v0x.md). Ask before changing. |
| Change auth, queue, vector storage, license, or any cross-cutting choice | Find the matching ADR in [docs/decisions/](docs/decisions/). Do not contradict. |
| Build a feature in an existing module (issues, agents, devices, chat, skills, memory) | The matching `docs/modules/<name>/README.md` |
| Add a new cross-module flow | [docs/architecture/cross-module-flows.md](docs/architecture/cross-module-flows.md) |
| Propose a significant change | Open a proposal in [docs/proposals/](docs/proposals/), upgrade to RFC if it crosses APIs |

If a doc disagrees with the code, **trust the code, then propose a doc fix** — do not silently re-derive.

## Current state (2026-04)

- **Backend:** `packages/core` (Hono + Drizzle + pg-boss + ws + MCP). Single process, single Postgres for data + jobs + vectors (`pgvector`). See [RFC 0002](docs/rfcs/0002-replace-strapi-with-hono-drizzle.md) + [docs/proposals/core-strapi-decoupling.md](docs/proposals/core-strapi-decoupling.md).
- **`forge/strapi/`** — removed at Phase 2.8-F1 (ISS-219); archive preserved at `legacy/strapi-v0` tag.
- **`packages/app/`** — paused per [ADR 0009](docs/decisions/0009-mobile-app-paused-for-v0x.md). No development.

## Packages

- **packages/core/** — Hono + Drizzle backend (the backend)
- **packages/web/** — Next.js 16 cloud UI
- **packages/dev/** — Tauri desktop app
- **packages/app/** — paused (ADR 0009)

`packages/core/`, `packages/web/`, `packages/dev/` join a pnpm workspace at `packages/`. Each other package is independent.

## Key Patterns

- TypeScript everywhere (Rust only for Tauri backend)
- React Query for server state; Zustand for client state (dev/app)
- WebSocket real-time broadcasts; room-scoped per principal in `core` (see [docs/architecture/websocket.md](docs/architecture/websocket.md))
- Feature modules organize by domain: `api.ts`, `types.ts`, `components/`, `hooks/`
- Bearer token in Authorization header; always use `apiClient`, never raw `fetch`
- ADRs are append-only — never edit a past decision; supersede with a new ADR

## Branching strategy — Trunk-Based Development

Single trunk = `main`. **No `develop`, no `staging`, no long-lived release branches.** Feature work merges to main as fast as it can compile + pass tests.

| Rule | Detail |
|---|---|
| Trunk | `main` only — always green, always deployable |
| Feature branches | `ISS-XX-<short>` cut from `main`, lifetime < 1 day, target same-day merge |
| Feature flags | Incomplete work merges behind `isEnabled('flagName')` from `packages/core/src/lib/feature-flags.ts` (default off) |
| Revert culture | If main breaks, **revert the offending commit within 30 min**. Do not push fix-forward unless revert is structurally impossible. |
| Hot-fix | Same as feature: branch from main, merge back fast. No separate hotfix track. |
| Pre-push hook | `.githooks/pre-push` runs build + tests on packages with changed files; install via `git config core.hooksPath .githooks` (auto-set by `pnpm install` postinstall). |
| Release tagging | Tag `vX.Y.Z` on commits when ready to ship. No release branch. |

### Status pipeline (Forge)

```
open → confirmed → approved → in_progress
                                  │ /forge-code
                                  ▼
                              developed   ◄── ISS-* branch pushed, awaits review
                                  │ /forge-review
                                  ▼
                              developed (pass) | reopen (fail → /forge-fix loop)
                                  │ /forge-release
                                  ▼
                              released    ◄── merged to main, push complete
                                  │ /forge-staging (auto-chained from release)
                                  ▼
                              staging     ◄── deployed to VPS, /health OK
                                  │ (human verifies on staging URL)
                                  ▼
                                closed
```

**Skipped statuses** (used by other projects with full Coolify pipeline): `tested`, `pass`, `deploying`, `testing`. The skill overrides under `.claude/skills/` enforce this — see `.claude/skills/README.md`.

### Feature flags currently defined

See `packages/core/src/lib/feature-flags.ts` for the live list. Per-epic flags during v1: `chatProvider`, `runnerFramework`, `pipelineControl`, `commentMentions`, `userPreferences`, `knowledgeOps`, `webhookAdapter`.

To enable a flag in an environment: `FEATURE_CHAT_PROVIDER=true` (camelCase → SCREAMING_SNAKE_CASE in the env name). Do **not** flip flags in code — only via env.

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
