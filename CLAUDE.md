@.forge/orientation.md

# Forge

Open-source control plane for Claude Code — full-stack project management + an AI agent pipeline
that drives Claude end-to-end.

**Constitution: [`docs/VISION.md`](docs/VISION.md)** — what Forge is / is not, why, who, and the
principles (incl. `VISION: state-never-lies`, `VISION: kernel-hard-policy-soft`). Intent only: no architecture,
no versions, no roadmap. On intent conflicts, VISION wins — cite it by name, never by section
number.

## Workspace

| Package | What |
|---|---|
| `packages/core` | Hono backend. Single app (`src/index.ts`) mounting per-domain route modules (`src/<domain>/routes.ts`); Drizzle ORM over Postgres (pgvector); WebSocket server (`/ws`); MCP server (`/mcp`, tools in `src/mcp/tools/forge-*.ts`); the job pool a master agent claims from. |
| `packages/web-v2` | Next.js cloud UI, canonical at `/`. Feature modules under `src/features/<domain>/`. |
| `packages/runner` | Headless Rust `forge-runner` CLI daemon (crates `forge-runner` / `forge-runner-core`) for servers/CI; pairs as a device. |
| `packages/contracts` | Shared cross-app TS types & registries (`issues.ts`, `pipeline-registry.ts`, `requests.ts`, `responses.ts`, `rows.ts`, `domain-templates.ts`). |
| `packages/observability` | Shared telemetry helpers (incl. the secret scrubber). |

**The driver skill lives in a second repo.** `github.com/SidCorp-co/forge-plugin` is Forge's own
Claude Code plugin — the `forge` CLI, the session hooks, and `plugin/skills/issue-flow`, which is
the skill `AUTONOMOUS_SKILL_NAME` names and every `drive` job runs. It reaches a runner through
`pipelineConfig.plugins` → `GET /api/devices/me/plugins`, gated by that box's `[plugins] enabled`.
Nothing in this repo can gate the pair: a change to the five driver statuses, the drive prompt, or
the phase endpoints has a second half in that repo, and the `cm:guard`s that name it are the only
record of the coupling. It is a Forge project too (`forge-plugin`, autonomous, pinned to a SHA).

## Commands

**`pnpm verify` when you finish coding, before you push** — the conformance entrypoint. It reports
every check it runs in one pass instead of stopping at the first, and prints the `cm:guard` /
`cm:edge` / `cm:flow` declared on the files you touched. Exit `0` clean · `1` violations · `2` a
check could not run. Hooks only make it arrive sooner; a contributor with no plugin installed is
held to exactly the same bar.

**A green `verify` is not a green CI.** It does not run the test suites or the build — it declares
them instead, and prints them under *"CI runs these too — verify does NOT"* at the end of every
run. Run `pnpm test`, `pnpm --filter @forge/core test:integration` and `pnpm build` yourself before
you push, and read that block rather than grepping the `ok`/`red` lines past it. This paragraph
used to say verify "runs every check CI runs"; that sentence put a red commit on `main` on
2026-09-01 — refactoring a mocked call path passed all 21 checks and failed `pnpm test` on CI.

From the repo root, turbo fans out: `pnpm dev` / `pnpm build` / `pnpm test` / `pnpm typecheck` /
`pnpm lint`. Per package (from inside `packages/<pkg>/`):

| Package | Dev | Build | Test | Lint |
|---------|-----|-------|------|------|
| core | `pnpm dev` (tsx watch) | `pnpm build` (tsc) | `pnpm test` (vitest); `pnpm test:integration` | `pnpm lint` (biome) |
| web-v2 | `pnpm dev` (next, :3100) | `pnpm build` | `pnpm test` (vitest) | `pnpm lint` (`check-lint-budget`, not biome directly) |
| runner | — | `cargo build` (in `packages/runner`) | `cargo test` | — |

DB (in `packages/core`): `pnpm db:generate` · `pnpm db:migrate` · `pnpm db:studio` (drizzle-kit).



## Fifteen gates, six axes

Each gate sits in `ci-passed`'s `needs` **and** is named in its result loop, so a violation blocks
the merge. **That, not this file, is why they hold.** All fifteen run from `pnpm verify`, and
`verify --ci-parity` is itself a CI step: a `- run:` in `ci.yml` that `verify` neither runs nor
declares fails the build, so the local command and the workflow cannot drift apart.

Six axes — form (gated 4×), knowledge (gated 5×), relations, behaviour (gated 3×), language, record.
Five of them own a property of the code; `record` owns `CHANGELOG.md`, the external record of what
shipped, which was nobody's until 1,034 lines of it left in silence. An axis measures
at its weakest gate. `.forge/conformance.json` declares each axis's level and the repo's profile
(today: hardened); `conformance-status.mjs` **runs** every checker and fails when what it does
disagrees with what the manifest claims.

Thresholds live in one place per axis: `.arch.json` for architecture contracts, and
`packages/core/biome.json` for the file/function line limits. **Do not add a rule to an axis another
already owns** — no ESLint, no comment rules outside codemap, no comments inside `biome.json`.

Which gate owns what, the conformance levels and their baseline directions, and what each rule was
born from: **[`scripts/README.md`](scripts/README.md)**.

## Doing the work

**Take the complete fix and pay the larger workload for it.** Where a smaller change and a whole
one both close the issue, the whole one is the deliverable — effort is not a reason to defer
structural work, and a workaround that becomes routine is a defect. The bound is the ownership
line, in this same breath because the two are one rule: no merging or reverting a shared branch, no
doing another issue's work, no silently overriding a human's decision. Everything inside that line
is yours whether or not it is in your AC; the first thing outside it is not, however cheap.

**A trade-off is priced or it is not taken.** `--update-baseline`, a waiver, a skipped test, a
`cm:hack` — each is an amnesty, and an amnesty with no stated price is how a gate stops meaning
what its row says. Name what was traded, what it costs, and the condition that ends it. An
undeclared trade-off is indistinguishable from an unnoticed one six weeks later.

**Before you change behaviour, know what you are replacing.** Requirement, then the design, then
the old logic this supersedes, then the cleanup that removes it. Code that ships beside the
thing it replaced leaves two live paths and a reader who cannot tell which one runs.

**A loud break beats a silent substitution.** When a refactor cannot do the thing that was asked,
it must fail where the gap is — never do the nearest thing that still returns. A redesign that
lands missing a piece and says so is recoverable in an afternoon; one that quietly answers with
something almost-right is found weeks later by the damage. So when the old path handled a case the
new one does not: refuse it by name. Do not widen a filter to swallow it, do not fall back to the
path being replaced, and do not delete the rows that no longer fit — an operator who is told
`no SSH provider for this repo` loses ten minutes, one whose job silently ran against a different
checkout loses the diff. The same rule governs the migration: a row the new schema cannot represent
aborts the deploy naming the row, rather than being cleaned away so the `ALTER` succeeds.

This is the one place effort is NOT the tiebreaker in reverse: a smaller change that preserves a
silent fallback is not the cheaper option, it is the one whose bill arrives later and unlabelled.

### There is no "already red"

**A defect you have seen may not leave your hands labelled "not mine".** In reach and inside the
ownership line → **fix it**, whoever caused it. Out of reach → it leaves as someone's work: a
`blocks` edge, a `docs/proposals/` line, or a comment with evidence (`waiting` + `reason` when it
blocks this issue). **Never a new issue** — filing a fixable defect instead of fixing it is the
`file-instead-of-fix` red flag, and it is what put 30 unread drafts on forge-dev by 2026-08-18.

**Disclosure is not a discharge.** A step that names a defect and ships anyway is a failed step,
not an honest one. Measured 2026-08-13: five `forge-test` runs wrote *"lint remains red only on
pre-existing, untouched diagnostics"* and merged — `core` is a required check. `core-integration`
was red on 5 tests at the same time, one of them ISS-812's own regression suite, which had never
run anywhere: code wrote it without running it, review approved it, test could not run it, all
three disclosed honestly and moved on. Nobody lied and nobody fixed it. "Pre-existing",
"untouched" and "out of scope" are reasons to **record**, never reasons to go quiet, and never
reasons to go green.

## Green is a claim about one proposition

**A green check is evidence for exactly one thing: that assertion held in the runtime that ran
it.** Where the runtime cannot represent the failure, a pass is not weak evidence — it is none, and
it is indistinguishable from a strong one. So ask what would have to be true for the assertion to
go red, **plant exactly that, and watch it go red naming its own rule** before the green means
anything. A test that cannot fail has not been written yet.

Cover the axes, not just the happy path: happy · negative · boundary · extreme/edge · the business
rule itself. Which axes a given step owes, and the evidence it must show: the `forge-test` skill.

## Documentation is deleted, not carried

**Better no document than a wrong one.** A doc that cannot be verified is removed in the change
that discovers it — no deprecation note, no "may be stale" header. Both are a second copy of a
status the code already holds.

**The files you read are your doc-review worklist.** Finishing an issue means every `.md` you
opened while working it comes back marked *still true* / *edited* / *deleted*. "Did not touch" is
not one of the three. Enforced in the pipeline by `forge-code`.

Cite a doc claim so it can be checked: name the identifier or the `file.ts:symbol` anchor, never a
line number — a line number is stale the moment anything above it moves, and stale in silence.

## Invariants

- **No child `jobs` row stays non-terminal under a terminal `pipeline_run`** — one orphan wedges a
  runner slot. Three defences in lockstep (close-cascade, loop monitor, pool exclusion), plus
  `held` as a deliberate fourth shape that is NOT an orphan. New code that flips
  `pipeline_runs.status` terminal MUST route through a cascade-calling helper. The `cm:guard` and
  the two `cm:edge lockstep` live on `packages/core/src/pipeline/runs-cascade.ts`; the four hops and
  their thresholds are modelled in `packages/core/src/jobs/loop-monitor.ts`.
- **A migration's `when` in `drizzle/migrations/meta/_journal.json` must exceed EVERY `created_at`
  already in the target DB** — drizzle reads the single highest `created_at` once and skips lower
  entries **silently, forever**, so the container starts and serves new code against an old schema
  (ISS-807: a live 500 on `GET /me/attention` for every signed-in user). Take `max(when)` across the
  journal and add `86400000`; never a real timestamp. Gated by `db/migrations-journal.test.ts`.


## Where the detail lives

| | |
|---|---|
| Comment & annotation doctrine | `.claude/rules/codemap.md` (auto-loads on source files) · `.forge/codemap/SPEC.md` |
| Every gate, its baseline, its origin | `scripts/README.md` |
| Architecture, orphan hygiene, observability | `docs/architecture/` |
| Per-domain deep detail | `docs/modules/<domain>/` |
