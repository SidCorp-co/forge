@.forge/orientation.md

# Forge

Open-source control plane for Claude Code — full-stack project management + an AI agent pipeline
that drives Claude end-to-end (triage → clarify → plan → code → review → test → release). pnpm +
turbo monorepo, root package `forge`.

**Constitution: [`docs/VISION.md`](docs/VISION.md)** — what Forge is / is not, principles (incl.
№10 state-never-lies, №11 kernel-hard-policy-soft), roadmap. On intent conflicts, VISION wins.

## Workspace

| Package | What |
|---|---|
| `packages/core` | Hono backend. Single app (`src/index.ts`) mounting per-domain route modules (`src/<domain>/routes.ts`); Drizzle ORM over Postgres (pgvector); WebSocket server (`/ws`); MCP server (`/mcp`, tools in `src/mcp/tools/forge-*.ts`); the pipeline dispatcher that drives Claude. |
| `packages/web-v2` | Next.js cloud UI, canonical at `/`. Feature modules under `src/features/<domain>/`. |
| `packages/runner` | Headless Rust `forge-runner` CLI daemon (crates `forge-runner` / `forge-runner-core`) for servers/CI; pairs as a device. See `docs/architecture/runner-daemon.md`. |
| `packages/contracts` | Shared cross-app TS types & registries (`issues.ts`, `pipeline-registry.ts`, `requests.ts`, `responses.ts`, `rows.ts`, `domain-templates.ts`). |
| `packages/observability` | Shared telemetry helpers (incl. the secret scrubber). |

A local `packages/web/`, `packages/dev/` or `nexus/` is leftover build residue — none has tracked
files, all three are retired, safe to delete.

## Commands

**`pnpm verify` when you finish coding, before you push** — the conformance entrypoint. It runs
every check CI runs, reports all of them in one pass instead of stopping at the first, and prints
the `cm:guard` / `cm:edge` / `cm:flow` declared on the files you touched. Exit `0` clean · `1`
violations · `2` a check could not run. Hooks only make it arrive sooner; a contributor with no
plugin installed is held to exactly the same bar.

From the repo root, turbo fans out: `pnpm dev` / `pnpm build` / `pnpm test` / `pnpm typecheck` /
`pnpm lint`. Per package (from inside `packages/<pkg>/`):

| Package | Dev | Build | Test | Lint |
|---------|-----|-------|------|------|
| core | `pnpm dev` (tsx watch) | `pnpm build` (tsc) | `pnpm test` (vitest); `pnpm test:integration` | `pnpm lint` (biome) |
| web-v2 | `pnpm dev` (next, :3100) | `pnpm build` | `pnpm test` (vitest) | `pnpm lint` (`check-lint-budget`, not biome directly) |
| runner | — | `cargo build` (in `packages/runner`) | `cargo test` | — |

DB (in `packages/core`): `pnpm db:generate` · `pnpm db:migrate` · `pnpm db:studio` (drizzle-kit).

## Key patterns

- TypeScript everywhere (Rust only for the runner)
- All UI clients share the same `core` Hono REST contract (mirrored in `packages/contracts`)
- React Query for server state
- Real-time: WebSocket broadcasts from `core` (`/ws`) to all UIs
- core domain modules: `routes.ts` + service/helper files + co-located `*.test.ts`; web feature
  modules: `api.ts`, `types.ts`, `components/`, `hooks/`
- Bearer token in Authorization header; web always uses `apiClient` (`src/lib/api/client.ts`),
  never raw `fetch`
- DB is source of truth: enums/tables live in `packages/core/src/db/schema.ts`; change via
  `pnpm db:generate` + `pnpm db:migrate` (drizzle-kit)

## Comments

**If a tool can derive it, don't write it.** No `TODO`/`FIXME` — fix it in the change you are
already making and declare it under `Extra fixes:`. Couplings no tool can see are recorded as
one-line `cm:` annotations: `cm:guard` `cm:edge` `cm:flow` `cm:hack` `cm:why`. Full doctrine, and
what earns an annotation: **[`.claude/rules/codemap.md`](.claude/rules/codemap.md)**, which loads
automatically when you open a source file. Gate: `cm verify` (CI job `codemap`).

## Ten gates, five axes

Each gate sits in `ci-passed`'s `needs` **and** is named in its result loop, so a violation blocks
the merge. **That, not this file, is why they hold.** All ten run from `pnpm verify`, and
`verify --ci-parity` is itself a CI step: a `- run:` in `ci.yml` that `verify` neither runs nor
declares fails the build, so the local command and the workflow cannot drift apart.

Five axes — form (gated 4×), knowledge, relations, behaviour (gated 3×), language. An axis measures
at its weakest gate. `.forge/conformance.json` declares each axis's level and the repo's profile
(today: hardened); `conformance-status.mjs` **runs** every checker and fails when what it does
disagrees with what the manifest claims.

Thresholds live in one place per axis: `.arch.json` for architecture contracts, and
`packages/core/biome.json` for the file/function line limits. **Do not add a rule to an axis another
already owns** — no ESLint, no comment rules outside codemap, no comments inside `biome.json`.

Which gate owns what, the conformance levels and their baseline directions, and what each rule was
born from: **[`scripts/README.md`](scripts/README.md)**.

### There is no "already red"

**A defect you have seen may not leave your hands labelled "not mine".** In reach and inside the
ownership line (no merging or reverting a shared branch, no doing another issue's work, no silently
overriding a human's decision) → **fix it**, whoever caused it and whether or not it is in your AC.
Out of reach → it leaves as someone's work: a `blocks` edge, a `docs/proposals/` line, or a comment
with evidence (`waiting` + `reason` when it blocks this issue). **Never a new issue** — filing a
fixable defect instead of fixing it is the `file-instead-of-fix` red flag, and it is what put 30
unread drafts on forge-dev by 2026-08-18.

"Pre-existing", "untouched", "out of scope" are reasons to **record**, never reasons to go quiet.
Measured 2026-08-13: five `forge-test` runs wrote *"lint remains red only on pre-existing, untouched
diagnostics"* and merged — `core` is a required check. `core-integration` was red on 5 tests at the
same time, one of them ISS-812's own regression suite, which had never run anywhere: code wrote it
without running it, review approved it, test could not run it, all three disclosed honestly and
moved on. Nobody lied and nobody fixed it. "Already red" only means earlier steps dodged too.

## Invariants

- **No child `jobs` row stays non-terminal under a terminal `pipeline_run`** — one orphan wedges a
  cap=1 runner slot. Three defences in lockstep (close-cascade, loop monitor, dispatch gates), plus
  `held` as a deliberate fourth shape that is NOT an orphan. New code that flips
  `pipeline_runs.status` terminal MUST route through a cascade-calling helper. The `cm:guard` and
  the two `cm:edge lockstep` live on `packages/core/src/pipeline/runs-cascade.ts`; the table is in
  [`docs/architecture/job-loop-monitor.md`](docs/architecture/job-loop-monitor.md).
- **A migration's `when` in `drizzle/migrations/meta/_journal.json` must exceed EVERY `created_at`
  already in the target DB** — drizzle reads the single highest `created_at` once and skips lower
  entries **silently, forever**, so the container starts and serves new code against an old schema
  (ISS-807: a live 500 on `GET /me/attention` for every signed-in user). Take `max(when)` across the
  journal and add `86400000`; never a real timestamp. Gated by `db/migrations-journal.test.ts`.

## Recipes

- **New core endpoint** → route module `packages/core/src/<domain>/routes.ts` (Hono + Drizzle) +
  mount in `src/index.ts`
- **New MCP tool** → `packages/core/src/mcp/tools/forge-<name>.ts`
- **New web feature** → `packages/web-v2/src/features/<name>/` with `api.ts` + `types.ts` +
  `hooks/` + `components/`
- **Schema change** → `packages/core/src/db/schema.ts` → `pnpm db:generate` + `pnpm db:migrate` →
  propagate to `packages/contracts` → web/dev TS types → MCP tool descriptions

## Where the detail lives

| | |
|---|---|
| Comment & annotation doctrine | `.claude/rules/codemap.md` (auto-loads on source files) · `.forge/codemap/SPEC.md` |
| Every gate, its baseline, its origin | `scripts/README.md` |
| Architecture, orphan hygiene, observability | `docs/architecture/` |
| Per-domain deep detail | `docs/modules/<domain>/` |
