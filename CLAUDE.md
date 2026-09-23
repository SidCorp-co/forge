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
| `packages/core` | Hono backend. Single app (`packages/core/src/index.ts`) mounting per-domain route modules (`src/<domain>/routes.ts`); Drizzle ORM over Postgres (pgvector); WebSocket server (`/ws`); MCP server (`/mcp`, tools in `src/mcp/tools/forge-*.ts`); the job pool a master agent claims from. |
| `packages/web-v2` | Next.js cloud UI, canonical at `/`. Feature modules under `src/features/<domain>/`. |
| `packages/runner` | Headless Rust `forge-runner` CLI daemon (crates `forge-runner` / `forge-runner-core`) for servers/CI; pairs as a device. |
| `packages/contracts` | Shared cross-app TS types & registries, all under `packages/contracts/src/`: `packages/contracts/src/issues.ts`, `packages/contracts/src/pipeline-registry.ts`, `packages/contracts/src/requests.ts`, `packages/contracts/src/responses.ts`, `packages/contracts/src/rows.ts`, `packages/contracts/src/domain-templates.ts`. |
| `packages/observability` | Shared telemetry helpers (incl. the secret scrubber). |

**The driver skill lives in a second repo.** `github.com/SidCorp-co/forge-plugin` is Forge's own
Claude Code plugin — the `forge` CLI, the session hooks, and `plugin/skills/issue-flow`, which is
the skill `AUTONOMOUS_SKILL_NAME` names and every `drive` job runs. It reaches a runner through
`pipelineConfig.plugins` → `GET /api/devices/me/plugins`, gated by that box's `[plugins] enabled`.
Nothing in this repo can gate the pair: a change to the five driver statuses, the drive prompt, or
the phase endpoints has a second half in that repo, and nothing here records the coupling. It is a
Forge project too (`forge-plugin`, autonomous, pinned to a SHA).

## Commands

**`pnpm verify` when you finish coding, before you push** — the conformance entrypoint. It reports
every check it runs in one pass instead of stopping at the first. Exit `0` clean · `1` violations ·
`2` a check could not run. Hooks only make it arrive sooner; a contributor with no plugin installed is
held to exactly the same bar.

**A green `verify` is not a green CI.** It does not run the test suites or the build — it declares
them instead, and prints them under *"CI runs these too — verify does NOT"* at the end of every
run. Run `pnpm test`, `pnpm --filter @forge/core test:integration` and `pnpm build` yourself before
you push, and read that block rather than grepping the `ok`/`red` lines past it. This paragraph
used to say verify "runs every check CI runs"; that sentence put a red commit on `main` on
2026-09-01 — refactoring a mocked call path passed all 21 checks and failed `pnpm test` on CI.

**`pnpm test:changed` is the loop, never the proof.** It runs the tests the change reaches plus the
14 that scan the source tree instead of importing it — 125 of 447 core files in 41s on a typical
commit, against 112s for the lot. It is wired to nothing: no gate reads it, and it prints that it is
not a green on every run, because `vitest`'s graph follows imports and a test that reaches its
subject by URL, table name or file path is not in it. `pnpm test` before you push, always.

From the repo root, turbo fans out: `pnpm dev` / `pnpm build` / `pnpm test` / `pnpm typecheck` /
`pnpm lint`. Per package (from inside `packages/<pkg>/`):

| Package | Dev | Build | Test | Lint |
|---------|-----|-------|------|------|
| core | `pnpm dev` (tsx watch) | `pnpm build` (tsc) | `pnpm test` (vitest); `pnpm test:integration` | `pnpm lint` (biome) |
| web-v2 | `pnpm dev` (next, :3100) | `pnpm build` | `pnpm test` (vitest) | `pnpm lint` (`check-lint-budget`, not biome directly) |
| runner | — | `cargo build` (in `packages/runner`) | `cargo test` | — |

DB (in `packages/core`): `pnpm db:generate` · `pnpm db:migrate` · `pnpm db:studio` (drizzle-kit).



## Every gate, seven axes

Each gate sits in `ci-passed`'s `needs` **and** is named in its result loop, so a violation blocks
the merge. **That, not this file, is why they hold.** Every one runs from `pnpm verify`, which
prints its own count. This heading no longer carries one: it said `fourteen` over a `verify` that
ran twenty-three checks across eleven gate jobs, matching neither. `verify --ci-parity` is itself
a CI step: a `- run:` in `.github/workflows/ci.yml` that `verify`
neither runs nor declares fails the build, so the local command and the workflow cannot drift
apart.

Seven axes — form (gated 5×), knowledge (gated 5×), relations, behaviour (gated 3×), language,
record, comment. Five of them own a property of the code; `record` owns `CHANGELOG.md`, the
external record of what shipped, which was nobody's until 1,034 lines of it left in silence, and
`comment` owns what a comment SAYS. An axis measures at its weakest gate. `.forge/conformance.json` declares each axis's level and the repo's profile
(today: hardened); `scripts/conformance-status.mjs` **runs** every checker and fails when what it does
disagrees with what the manifest claims.

Thresholds live in one place per axis: `.arch.json` for architecture contracts, and
`packages/core/biome.json` for the file/function line limits. **Do not add a rule to an axis another
already owns** — no comments inside `packages/core/biome.json`, and nothing that re-measures file or function
length, which biome owns at 500/150 with `check-size-budget` as its baseline.

**Comment content is the one axis that was vacant, and now is not.** The codemap checker that used
to own it was removed and its annotations deleted, which left prose in this repo measured by
nothing. `eslint-plugin-code-quality` is vendored at `.forge/code-quality/` — the same shape as
`.forge/archmap/`, so `pnpm install` needs no path outside the repo — and runs as
`pnpm lint:code-quality` over `eslint.config.mjs`. It owns comment density, historical narration,
duplicated comments and comment-run length, and nothing else here may.

Those four rules — and no other half of that command — are gated by `check-comment-budget`, a
per-file per-rule freeze in the shape `check-lint-budget` already had, run from `verify` and from
the `conformance` job. It landed green over an amnesty of 73 findings across 67 files, priced in
`.forge/conformance.json`'s `comment` axis with the condition that ends it. What that command
reports BESIDE the four — raw elements, pass-through wrappers, crowded directories, the
design-token sweep — belongs to axes nobody has declared and is measured by nothing.

A comment whose text OPENS with a directive is not prose and is skipped: `eslint-disable` and the
`@ts-` family always, plus whatever `additionalDirectives` in `eslint.config.mjs` names — here
`i18n-allow` and `biome-ignore`, whose wording belongs to the gate reading it.

Which gate owns what, the conformance levels and their baseline directions, and what each rule was
born from: **[`scripts/README.md`](scripts/README.md)**.

## Doing the work

**Take the complete fix and pay the larger workload for it.** Where a smaller change and a whole
one both close the issue, the whole one is the deliverable — effort is not a reason to defer
structural work, and a workaround that becomes routine is a defect. The bound is the ownership
line, in this same breath because the two are one rule: no merging or reverting a shared branch, no
doing another issue's work, no silently overriding a human's decision. Everything inside that line
is yours whether or not it is in your AC; the first thing outside it is not, however cheap.

**A trade-off is priced or it is not taken.** `--update-baseline`, a waiver, a skipped test —
each is an amnesty, and an amnesty with no stated price is how a gate stops meaning
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

**Wrong input is refused by name, not absorbed.** A caller who broke the contract gets told what
was wrong, where, and what shape is valid — the refusal IS the deliverable, and a special path
built to make one caller's mistake return something is a second live path nobody documented. Do
not widen a schema to accept the malformed value, do not guess the intent behind it, and do not
carry a compatibility branch for a shape that was never legal. The way out is the interface, not
the exception — the message, the guide, the example carried in the error itself.

Three things wear that same face, and only the first is the caller's:

- **A real contract break** → refuse by name, above.
- **A silence** → OURS, whoever typed the input. A journal entry drizzle cannot use is skipped
  *silently, forever* and the container serves new code on an old schema (ISS-807); a call that
  returns `200` and does nothing is a defect on our side of the line. Fix it to fail loudly, and
  plant the malformed input to watch it go red before the fix counts for anything.
- **An affordance defect** → the wrong use IS the natural reading of the interface. One reader
  misreading buys a clearer error; the same affordance biting twice buys a redesign, and "we will
  document it better" is how that redesign gets deferred a third time. A `patch` that replaced a
  nested map wholesale wiped every key the caller did not resend, and four callers each defended
  themselves against it by hand — so ISS-1170 took the redesign: a settings write is
  `{ base, patch }`, `patch` names only the keys being changed and merges by path, `base` is what
  the caller read, and a write whose base moved at a path it writes is refused naming that path.

Which of the three you may absorb follows `VISION: kernel-hard-policy-soft`. Kernel input — job,
session, run, state, transition, evidence, retry, escalation — has zero tolerance: a
representable-looking wrong value there is how state starts lying. Policy input may normalize, but
an unreported normalization is a guess, and a guess is the silent substitution again under a
friendlier name. A wrong use already load-bearing in the field is a priced amnesty, named with the
issue and the condition that ends it — never a quiet accommodation.

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

### The one carve-out: forge-plugin is reached by issue, never by diff

**A defect in `github.com/SidCorp-co/forge-plugin` leaves as an issue on the `forge-plugin`
project, and you do not edit that repo from a job in this one.** The `forge` CLI, the session
hooks and `plugin/skills/issue-flow` live there; a verb that refuses wrongly, a missing way out, a
skill naming something this repo no longer has — all of it files there and is named in your
comment under `Extra fixes:` as **reported**, not fixed.

This is the single exception to *fix-it-now*, and it is a boundary rather than an amnesty: the two
repos ship on different clocks, and a change landing there from here is a change none of this
repo's gates has seen and none of that repo's reviewers asked for. The defect still leaves
your hands owned — it leaves owned by a row somebody can open, which is exactly what
`file-instead-of-fix` refuses everywhere else and requires here.

The pair is not symmetric. Nothing in this repo can gate that one: a change to the five driver
statuses, the drive prompt or the phase endpoints has a second half over there, and nothing here
records the coupling.

### An issue that does leave names the mechanism, not the symptom

**Where an issue is the right container — a residual out of reach, a `forge-plugin` defect — it is
written to the root cause or it buys nothing.** Three parts, each already a rule above:

- **The deliverable is the mechanism, not the loop it broke.** The symptom is evidence attached to
  the issue, never its Outcome. *Take the complete fix* decides what goes in the title.
- **Reproduce before changing.** The failing path is reproduced deliberately and any fix is
  measured against that reproduction — *plant exactly that, and watch it go red* binds the issue as
  much as the test. A fix that cannot be shown closing a reproduced failure is a guess with a
  commit message.
- **What you could not explain is written down.** `VISION: state-never-lies` does not stop at the
  code: a causal chain stated with its gap is a starting point, the same chain implied whole is a
  trap for whoever picks it up.

Measured 2026-09-18 (forge-dev ISS-1099): a master pane was refused by the daemon that adopted it
across a restart, and answered 45 nudges over four hours while five rows stood still. The adhoc row
reads *"kill the pane when it reports stale capability"* and is closed by a `tmux kill-session`; the
deliverable is that a pane's authority survives the restart of the daemon adopting it. Same
evidence, same afternoon — one of them comes back next restart.

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

**Where a doc and the code disagree, the code is right.** Fix the doc in the same change rather
than re-deriving around it — a reader who has to decide which of the two to believe has already
lost the time the doc was written to save.

**The files you read are your doc-review worklist.** Finishing an issue means every `.md` you
opened while working it comes back marked *still true* / *edited* / *deleted*. "Did not touch" is
not one of the three. The pipeline's `forge-code` step decides which of the three a document gets,
and `check-doc-citations` decides whether it was entitled to say *still true*: every citation of a
file in this repo is resolved against the tree, a dead one fails the build, and one whose target
moved after the document did comes back on the worklist. Prose is still the step's alone.

<!-- doc-citation: unchecked `file.ts:symbol` — the NOTATION being defined, not a file this repo holds. -->
Cite a doc claim so it can be checked: name the identifier or the `file.ts:symbol` anchor, never a
line number — a line number is stale the moment anything above it moves, and stale in silence.

## Invariants

- **A `pipeline_run` and its child `jobs` reach terminal together, in BOTH directions.** Read one
  way only and the other one leaks in silence: defending the forward half alone left 98 of 114
  live runs `running` with every job terminal, across 18 projects, presenting as in-flight work no
  box was doing (ISS-923).
  - *Forward — no child `jobs` row stays non-terminal under a terminal `pipeline_run`*: one orphan
    wedges a runner slot. Three defences in lockstep (close-cascade, loop monitor, pool exclusion),
    plus `held` as a deliberate fourth shape that is NOT an orphan. The cascade lives in
    `packages/core/src/pipeline/runs-cascade.ts`; the four hops and their thresholds are modelled in
    `packages/core/src/jobs/loop-monitor.ts`.
  - *Inverse — no `pipeline_run` stays non-terminal once every child job is terminal*:
    `packages/core/src/pipeline/runs-concluded.ts`, driven from the sweeper tick, closing on the
    LAST job's outcome so a run whose last job failed never closes `completed`.
  - New code that flips `pipeline_runs.status` terminal MUST route through a cascade-calling
    helper — on either axis, there is exactly one writer.
- **A migration's `when` in `packages/core/drizzle/migrations/meta/_journal.json` must exceed EVERY `created_at`
  already in the target DB** — drizzle reads the single highest `created_at` once and skips lower
  entries **silently, forever**, so the container starts and serves new code against an old schema
  (ISS-807: a live 500 on `GET /me/attention` for every signed-in user). **`node
  scripts/check-migration-order.mjs` prints the number to take**, derived across `origin/main` and
  every open branch, and refuses a `when` that collides with, straddles or falls below one of
  theirs. Never a real timestamp: the values here are synthetic whole days, and the checker's
  `Next free:` line is the only place to read the next one from.

  The set is the subject, not your branch. Branches each deriving `+86400000` from one `main` all
  land on the SAME number and whichever merges first silently kills the rest — measured twice on
  2026-09-17, four open migrations, three of them holding `1796083200000`. Two gates split the
  work: `packages/core/src/db/migrations-journal.test.ts` owns one journal's own properties, and
  `scripts/check-migration-order.mjs` owns the relation between branches, running from `pnpm verify` and
  from the always-on `lang-check` CI job. What neither can catch is a merge taken out of the order
  the checker derived, which costs the branch behind it a renumber rather than its migration —
  `scripts/README.md` has the residual in full.


## Where the detail lives

| | |
|---|---|
| Every gate, its baseline, its origin | `scripts/README.md` |
| Architecture, the data plane, and where both are going | `docs/proposals/destination/` |
| The target, and what the tree does instead | `docs/proposals/destination/` |
