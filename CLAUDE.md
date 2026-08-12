<!-- forge:orientation -->
<!-- Forge-managed pointer (fixed). Project orientation lives in .forge/orientation.md. -->
@.forge/orientation.md
<!-- /forge:orientation -->

# Forge

Open-source control plane for Claude Code — full-stack project management + an AI agent pipeline that drives Claude end-to-end (triage → clarify → plan → code → review → test → release). pnpm + turbo monorepo, root package `forge`.

**Constitution: [`docs/VISION.md`](docs/VISION.md)** — what Forge is / is not, principles (incl. №10 state-never-lies, №11 kernel-hard-policy-soft), roadmap. On intent conflicts, VISION wins.

## Workspace

| Package | What |
|---|---|
| `packages/core` | Hono backend. Single app (`src/index.ts`) mounting per-domain route modules (`src/<domain>/routes.ts`); Drizzle ORM over Postgres (pgvector); WebSocket server (`/ws`); MCP server (`/mcp`, tools in `src/mcp/tools/forge-*.ts`); the pipeline dispatcher that drives Claude. |
| `packages/web-v2` | Next.js cloud UI, canonical at `/`. Feature modules under `src/features/<domain>/`. |
| `packages/dev` | Tauri desktop app (Vite + React + react-router-dom + Zustand; Rust backend in `src-tauri/`) for local codebase access + Claude CLI agent. |
| `packages/runner` | Headless Rust `forge-runner` CLI daemon (crates `forge-runner` / `forge-runner-core`) for servers/CI; pairs as a device. See `docs/architecture/runner-daemon.md`. |
| `packages/contracts` | Shared cross-app TS types & registries (`issues.ts`, `pipeline-registry.ts`, `requests.ts`, `responses.ts`, `rows.ts`, `domain-templates.ts`). |
| `packages/observability` | Shared telemetry helpers (incl. the secret scrubber). |

`packages/web` is retired (empty — web-v2 replaced it); `nexus` is gone from `pnpm-workspace.yaml`. Neither has tracked files, so a local `packages/web/` or `nexus/` is leftover build/`node_modules` residue and safe to delete.

## Key patterns

- TypeScript everywhere (Rust only for the Tauri backend + runner)
- All UI clients share the same `core` Hono REST contract (mirrored in `packages/contracts`)
- React Query for server state; Zustand for client state (dev)
- Real-time: WebSocket broadcasts from `core` (`/ws`) to all UIs
- core domain modules: `routes.ts` + service/helper files + co-located `*.test.ts`; web/dev feature modules: `api.ts`, `types.ts`, `components/`, `hooks/`
- Bearer token in Authorization header; web always uses `apiClient` (`src/lib/api/client.ts`), never raw `fetch`
- DB is source of truth: enums/tables live in `packages/core/src/db/schema.ts`; change via `pnpm db:generate` + `pnpm db:migrate` (drizzle-kit)

## Comments & CodeMap (`codemap/1`)

This repo **owns its checker**: `.forge/codemap/cm` is vendored (codemap 0.12.0) and is the
authority — it wins over a `cm` on PATH, which wins over the plugin's bundled copy. Config:
`.forge/codemap.json` (flow vocabulary + enforcement scope) · `.forge/codemap-baseline.json`
(13,304 legacy comments across 1,080 files frozen by CONTENT — a comment is flagged only when its
text is new, so a reflow or a move is not a violation). **Gate**: the `codemap` job in
`.github/workflows/ci.yml` sits in `ci-passed`'s `needs` list, so a violation blocks the merge. It
runs the prose tier scoped to the PR's changed lines (`--since $(git merge-base origin/main HEAD)`)
plus the referential and structural tiers whole-tree — the second part is load-bearing: a scoped run
attributes a dangling `cm:edge` to the annotated file and drops it when that file is outside the
diff. Bump the checker with `cm install --upgrade`; `.github/workflows/codemap-upgrade.yml` opens
that PR weekly, and `cm doctor` shows any skew. Post-baseline prose is at 0, so anything the gate
reports is something you just added. Spec: `.forge/codemap/SPEC.md`.

**Rule: if a tool can derive it, don't write it.** No `// Load the config` — the compiler already
says that. No new `TODO`/`FIXME`: file an issue at `draft` instead. Orientation prose goes in the
**module header** (first comment block, followed by a blank line, ≤20 lines); `/** */` on an
`export` is fine (IDE hover docs).

Record the couplings no tool can see, as one-line annotations on line comments (never inside
`/** */`):

| | |
|---|---|
| `// cm:guard <text>` | invariant whoever edits this must obey — **injected into the agent's context before it edits the file** |
| `// cm:edge <kind> -> <repo/path> — <why>` | coupling nothing links. Kinds: `contract` `ordering` `lockstep` `sideeffect` `naming` `protocol` |
| `// cm:flow <flow>/<step> [after:<step>]` | step of a named runtime flow (declare the flow first: `cm new flow`) |
| `// cm:hack ISS-<n> until:<cond> — <text>` | live workaround with an exit condition |
| `// cm:why <text>` | one-line rationale |

Before changing a file with declared couplings: `cm impact <path>` (declared half) **plus** LSP
references (derivable half) — neither is a substitute for the other. `cm verify` before pushing;
`cm fmt` normalizes. Full verb list: `cm` with no args, or the `codemap` skill.

The lockstep edges on `cascadeCancelChildJobs` are the machine-readable form of the orphan-hygiene
table below — change one, check the other.

## Commands

From the repo root, turbo fans out: `pnpm dev` / `pnpm build` / `pnpm test` / `pnpm typecheck` / `pnpm lint`. Per package (from inside `packages/<pkg>/`):

| Package | Dev | Build | Test | Lint |
|---------|-----|-------|------|------|
| core | `pnpm dev` (tsx watch) | `pnpm build` (tsc) | `pnpm test` (vitest); `pnpm test:integration` | `pnpm lint` (biome) |
| web-v2 | `pnpm dev` (next, :3100) | `pnpm build` | `pnpm test` (vitest) | no-op stub (WIP) |
| dev | `pnpm tauri dev` | `pnpm tauri build` | `npx vitest` | — |
| runner | — | `cargo build` (in `packages/runner`) | `cargo test` | — |

DB (in `packages/core`): `pnpm db:generate` · `pnpm db:migrate` · `pnpm db:studio` (drizzle-kit).

> ⚠️ **Before working on `packages/dev`**: `tauri.conf.json` uses the production identifier `co.sidcorp.forge-beta` and config dir `forge-beta`. Building/running from source under the default config shares those OS-level identifiers (keychain service, config dir, deep-link scheme, single-instance ID) with an installed production beta and will hijack a running prod app. Use a separate dev namespace before building locally.

## Observability — Sentry (opt-in)

**OSS contract**: every Sentry init reads its DSN from env at build/run time. Source builds without those env vars compile cleanly with the SDK no-op'd — cloning and building never silently reports anywhere. Only official release artifacts bake DSNs (via CI secrets); self-hosted operators opt in by setting the env var in their own deploy environment.

| Service | Init location | Enable via |
|---------|---------------|-----------|
| backend (Hono) | `packages/core/src/observability/sentry.ts` | runtime `SENTRY_DSN` |
| cloud UI (Next.js) | `packages/web-v2/src/providers/sentry-init.tsx` | build-time `NEXT_PUBLIC_SENTRY_DSN` |
| desktop renderer | `packages/dev/src/lib/sentry.ts` | build-time `VITE_SENTRY_DSN` |
| desktop Rust (Tauri) | `packages/dev/src-tauri/src/main.rs` (`option_env!`) | build-time `FORGE_SENTRY_DSN_RUST` |

All payloads pass through a scrubber that replaces Authorization, X-Device-Token, Cookie, X-API-Key headers; `authToken`/`auth_token`/`jwt`/`apiKey`/`api_key`/`password`/`token` body fields; and tokenized URL query params with `[Filtered]`.

## Orphan job hygiene

**INVARIANT: no child `jobs` row stays non-terminal under a terminal `pipeline_run`.** (One orphan wedges a cap=1 runner slot.) Three defences, keep in lockstep:

| # | Defence | Where | Fires on |
|---|---------|-------|----------|
| 1 | Cascade on close — ALL terminal transitions route through `cascadeCancelChildJobs` | `packages/core/src/pipeline/runs-cascade.ts`; callers: `closeRun`, `closeRunIfOneShot`, `closeOpenRunForIssue` (`runs.ts`), `cancelPipelineRun` (`runs-control.ts`) | run goes terminal |
| 2 | Loop monitor — the primary reaper: `runLoopMonitor` / `reapAckMisses` / `reapResultMisses`, quiet threshold `RESULT_QUIET_MINUTES = 60` (don't lower — legit merges run long). Sweeper passes are demoted to alarm-only, except session-lost propagation `reapSessionLostJobs`. | `packages/core/src/jobs/loop-monitor.ts` · `packages/core/src/pipeline/sweeper.ts` | never claimed / gone quiet / dead session |
| 3 | Dispatch gates require `pr.status IN ('running','paused')` so terminal-parent orphans never count toward the runner cap | `packages/core/src/jobs/dispatch-gates.ts` (`countInFlightForRunner`, `checkLayer4RunnerFull`, `runner_load` CTE) | every dispatch |

- Cascade effects: jobs → `cancelled` (`failureKind='transient'`, `failureReason='pipeline_*'`); linked `agent_sessions` → `failed`; broadcasts `agent:abort`.
- New code that flips `pipeline_runs.status` terminal MUST route through a cascade-calling helper — no second mechanism cleans up after you.

## Pipeline-step analytics

The `pipeline_run_step_durations` SQL view (created in migration `0055`, reshaped by `0057` and `0128`) exposes **one row per finished job** (all terminal statuses):

| column | source |
|---|---|
| `run_id`, `project_id`, `issue_id` | `pipeline_runs` (issue_id is NULL for kind `pm`/`interactive`/`system`) |
| `step` | `jobs.type` (`triage`, `clarify`, `plan`, `code`, `review`, `test`, `release`, `fix`, `custom`, `pm`) |
| `started_at` | `COALESCE(agent_sessions.started_at, jobs.dispatched_at)` |
| `finished_at` | `jobs.finished_at` |
| `duration_seconds` | NULL unless the job is `done` — aggregate with `count(duration_seconds)`, not `count(*)` |
| `cost_usd` | sum of `usage_records.estimated_cost` for the job's `agent_session_id` (all statuses) |

REST surface: `GET /api/pipeline/step-durations?projectId=&days=&step=` (one JSON row per view row, camelCase keys).

Grafana starter (query the view, not raw tables):

```sql
SELECT step, percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_seconds) AS p95_s
FROM pipeline_run_step_durations
WHERE started_at >= now() - interval '7 days' AND duration_seconds IS NOT NULL
GROUP BY step ORDER BY p95_s DESC;
```

## Recipes

- **New core endpoint** → route module `packages/core/src/<domain>/routes.ts` (Hono + Drizzle) + mount in `src/index.ts`
- **New MCP tool** → `packages/core/src/mcp/tools/forge-<name>.ts`
- **New web feature** → `packages/web-v2/src/features/<name>/` with `api.ts` + `types.ts` + `hooks/` + `components/`
- **Schema change** → `packages/core/src/db/schema.ts` → `pnpm db:generate` + `pnpm db:migrate` → propagate to `packages/contracts` → web/dev TS types → MCP tool descriptions

> ⚠️ **A migration's `when` in `drizzle/migrations/meta/_journal.json` must exceed EVERY `created_at` already recorded in the target database — not just the previous entry's.** drizzle reads the single highest `created_at` once, before the loop, and applies only entries above it; per-hash presence is never checked. An entry at or below that watermark is skipped **silently, forever** — `migrate()` still reports success, so the container starts and serves new code against an old schema. This is not hypothetical: it put a live 500 on `GET /me/attention` for every signed-in user (ISS-807), because two hand-authored entries used real `Date.now()` values that were lower than a predecessor whose `when` had drifted into the future under this repo's `prev + 86400000` convention.
>
> Follow the convention — take `max(when)` across the journal and add `86400000` — rather than a real timestamp. `pnpm test` fails on a non-monotonic entry (`db/migrations-journal.test.ts`), and `db/migrate.js` prints a warning at startup naming any journal entry with no ledger row.
