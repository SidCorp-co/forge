# Jarvis Agents

Project management + AI agent platform.

## Before you start a task — read first

| You are about to... | Required reading |
|---|---|
| Touch `forge/core/` (the new Hono+Drizzle backend) | [docs/rfcs/0002](docs/rfcs/0002-replace-strapi-with-hono-drizzle.md) + [docs/proposals/core-strapi-decoupling.md](docs/proposals/core-strapi-decoupling.md) |
| Touch `forge/app/` (mobile) | **STOP** — paused per [ADR 0009](docs/decisions/0009-mobile-app-paused-for-v0x.md). Ask before changing. |
| Change auth, queue, vector storage, license, or any cross-cutting choice | Find the matching ADR in [docs/decisions/](docs/decisions/). Do not contradict. |
| Build a feature in an existing module (issues, agents, devices, chat, skills, memory) | The matching `docs/modules/<name>/README.md` |
| Add a new cross-module flow | [docs/architecture/cross-module-flows.md](docs/architecture/cross-module-flows.md) |
| Propose a significant change | Open a proposal in [docs/proposals/](docs/proposals/), upgrade to RFC if it crosses APIs |

If a doc disagrees with the code, **trust the code, then propose a doc fix** — do not silently re-derive.

## Current state (2026-04)

- **Backend:** `forge/core` (Hono + Drizzle + pg-boss + ws + MCP). Single process, single Postgres for data + jobs + vectors (`pgvector`). See [RFC 0002](docs/rfcs/0002-replace-strapi-with-hono-drizzle.md) + [docs/proposals/core-strapi-decoupling.md](docs/proposals/core-strapi-decoupling.md).
- **`forge/strapi/`** — removed at Phase 2.8-F1 (ISS-219); archive preserved at `legacy/strapi-v0` tag.
- **`forge/app/`** — paused per [ADR 0009](docs/decisions/0009-mobile-app-paused-for-v0x.md). No development.

## Packages

- **forge/core/** — Hono + Drizzle backend (the backend)
- **forge/web/** — Next.js 16 cloud UI
- **forge/dev/** — Tauri desktop app
- **forge/app/** — paused (ADR 0009)

`forge/core/`, `forge/web/`, `forge/dev/` join a pnpm workspace at `forge/`. Each other package is independent.

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
| Feature flags | Incomplete work merges behind `isEnabled('flagName')` from `forge/core/src/lib/feature-flags.ts` (default off) |
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

### Staging deployment

```bash
pnpm deploy:staging   # SSH to VPS, git fetch + reset main, docker rebuild, verify /health
```

Target VPS (configurable via `STAGING_*` env vars, defaults below):
- Host `root@165.22.96.128` — path `/opt/jarvis-stg-a2`
- Compose `docker-compose.prod.yml` project `jarvis-stg-a2`
- URL `https://stg-jarvis-a2.thejunix.com`

`forge-release` chains into `forge-staging` automatically after merging to main. On deploy failure, status stays at `released` for manual retry.

### Feature flags currently defined

See `forge/core/src/lib/feature-flags.ts` for the live list. Per-epic flags during v1: `chatProvider`, `runnerFramework`, `pipelineControl`, `commentMentions`, `userPreferences`, `knowledgeOps`, `webhookAdapter`.

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
