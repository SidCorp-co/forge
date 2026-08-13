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

### What earns an annotation

An annotation earns its place when **deleting it would let the next editor make a wrong change**.
Nothing validates the text, so this is the only test. Three things make one carry:

1. **The rule AND the consequence.** `a broken rule check must never freeze a legitimate
   transition` is 61 characters and complete — it says what must hold and what breaks otherwise.
   Short is not the problem; a short rule gets a short line.
2. **The mechanism that makes it non-obvious.** In `dispatch-gates.ts`, "write the identifiers
   LITERALLY" only earns its place because the next sentence says *why*: Drizzle renders a column
   reference inside a raw `sql` template unqualified. Without that, it reads as taste.
3. **Evidence, when the rule came from an incident.** A date, a measured number, the `ISS-`.
   `Measured on forge-beta 2026-08-11: 3 journal entries … have no bookkeeping row` can be
   re-checked, and dates it.

What does not earn one, with live examples from this repo: `cm:why issue lookup`,
`cm:why pendingSkillUpdates`, `cm:why shipped once`. Those are labels, not reasons — the compiler
already names the code. **Under ~30 characters, an annotation is almost always deletable.**

Pick by consumer, not by taste. `cm:guard` is **injected into the agent's context before it edits
the file**; `cm:edge` drives `cm impact`; **`cm:why` has no consumer at all** — nothing reads it,
not even `cm impact`. So anything a future editor must *obey* belongs in `cm:guard`, never
`cm:why`. Filler accumulates in `cm:why` precisely because nothing surfaces it.

## Three gates, three axes

Each sits in `ci-passed`'s `needs`, so a violation blocks the merge. **That, not this file, is why
they hold.** Both of the gates that already exist drifted badly while documented and non-blocking —
biome to 366 errors, `typecheck` to 84 — and stopped drifting the day they were cleared and gated
(see the comments on the `core` job in `.github/workflows/ci.yml`).

| Axis | Gate | Owns | Must not touch |
|---|---|---|---|
| format + lint | `biome check` — job `core` | whitespace, import order, recommended rules, file & function length | comment content |
| knowledge | `cm verify` — job `codemap` | `cm:` couplings, prose discipline, module headers | anything a tool can derive |
| relations | `arch check` — job `archmap` | which module may depend on which | how a file is written |

Do not add a rule to one axis that another already owns:

- **No ESLint.** biome ≥ 2 covers `noExcessiveLinesPerFunction` and `noExcessiveLinesPerFile`, which
  is the whole reason ESLint would have been added. A second linter on the same axis means two
  configs drifting apart.
- **No comment rules outside codemap.** A density or run-length rule contradicts it outright: the
  19-line `/** */` block on `failReconcileRunIfNoVerdictRecorded` is documentation codemap exempts
  by form, and 19 comment lines to a counter.
- **No `biome.json` comments.** A comment inside it makes biome **silently ignore the whole
  enclosing block** — no config error, the `overrides` just stop applying. Put the reasoning in the
  commit message.

`arch check` exit codes: `0` clean · `1` a new violation · `2` **the gate could not run** (bad flag,
unreadable manifest, a scope matching no files). Never read `2` as a pass — the same 1-vs-2 split
`cm verify` uses.

Thresholds live in one place per axis. `.arch.json` declares the architecture (modules by path glob,
plus `layers` / `forbidden` / `independence` / `fan-out` contracts, each `draft` or `locked`); the
file and function line limits live in `packages/core/biome.json`. Locking a contract means **no new
violations**, not zero violations.

### There is no "already red"

Three axes, not three checks — `ci-passed` also needs `core`, `core-integration`, `install-check`,
`lang-check`, `runner`, `docs`, `web`. The one that stayed red longest was an unnamed one.

**A defect you have seen may not leave your hands labelled "not mine".** In reach and inside the
ownership line (no merging or reverting a shared branch, no doing another issue's work, no silently
overriding a human's decision) → **fix it**, whoever caused it and whether or not it is in your AC.
Out of reach → it leaves as someone's work: an issue, a `blocks` edge, or a comment with evidence.

"Pre-existing", "untouched", "out of scope" are reasons to **record**, never reasons to go quiet.
Measured 2026-08-13: five `forge-test` runs wrote *"lint remains red only on pre-existing, untouched
diagnostics"* and merged — `core` is a required check. `core-integration` was red on 5 tests at the
same time, one of them ISS-812's own regression suite, which had never run anywhere: code wrote it
without running it, review approved it, test could not run it, all three disclosed honestly and
moved on. Nobody lied and nobody fixed it. "Already red" only means earlier steps dodged too.

**`.forge/` is committed, all of it.** Both checkers are vendored there (`.forge/codemap/`,
`.forge/archmap/`) and the CI jobs run those copies, so a contributor without a global install and
the gate are held to the same reviewed version — bump with `cm install --upgrade` / `arch install
--force` and commit the result. The registry, both baselines, and `orientation.md` (which this file
imports on its first line) live there too. `.forge/.gitignore` is the only place an exception may be
declared, and it carries the reason; a blanket `.forge/` in `.git/info/exclude` is a **local** rule
teammates never see, and it is why `orientation.md` went uncommitted for months.

Both vendored shims must stay mode `100755` — `git ls-files -s .forge/*/[ac]*` to check. A shim
committed `100644` fails the job with permission denied, not with a violation.

## Commands

**`pnpm verify` when you finish coding, before you push** — the conformance entrypoint. It runs
every check CI runs, reports all of them in one pass instead of stopping at the first, and prints
the `cm:guard` / `cm:edge` / `cm:flow` declared on the files you touched. Exit `0` clean · `1`
violations · `2` a check could not run. This is the mechanism; hooks only make it arrive sooner, and
a contributor with no plugin installed is held to exactly the same bar. Details and how to add a
check: `scripts/README.md`.

`verify --ci-parity` is itself a CI step: a `- run:` in `ci.yml` that `verify` neither runs nor
declares in `CI_COVERAGE` fails the build. That is what stops the local command and the workflow
drifting apart, which would make a green `pnpm verify` meaningless.

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
