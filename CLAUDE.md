@.forge/orientation.md

# Forge

**Constitution: [`docs/VISION.md`](docs/VISION.md)** — what Forge is / is not, why, who, and the
principles (incl. `VISION: state-never-lies`, `VISION: kernel-hard-policy-soft`). Intent only: no architecture,
no versions, no roadmap. On intent conflicts, VISION wins — cite it by name, never by section
number.

## Workspace

| Package | What |
|---|---|
| `packages/core` | Hono backend over Drizzle/Postgres, mounting per-domain routes from `packages/core/src/index.ts`; also the WebSocket server, the MCP server, and the job pool a master agent claims from. |
| `packages/web-v2` | Next.js cloud UI, canonical at `/`. Feature modules under `src/features/<domain>/`. |
| `packages/runner` | Headless Rust `forge-runner` CLI daemon for servers/CI; pairs as a device. |
| `packages/contracts` | Shared cross-app TS types & registries, under `packages/contracts/src/`. |
| `packages/observability` | Shared telemetry helpers (incl. the secret scrubber). |

**The driver skill lives in a second repo**, github.com/SidCorp-co/forge-plugin — Forge's own
Claude Code plugin, carrying the `forge` CLI, the session hooks, and the issue-flow skill that every
`drive` job runs. Nothing in this repo can gate the pair: a change to the five driver statuses, the
drive prompt or the phase endpoints has a second half in that repo, and nothing here records the
coupling. It is a Forge project too (`forge-plugin`, autonomous, pinned to a SHA).

## Commands

**`pnpm verify` when you finish coding, before you push** — the conformance entrypoint. Hooks only
make it arrive sooner; a contributor with no plugin installed is held to exactly the same bar.

**A green `verify` is not a green CI.** It declares the test suites and the build rather than
running them, under *"CI runs these too — verify does NOT"*; read that block, and run `pnpm test`,
`pnpm --filter @forge/core test:integration` and `pnpm build` yourself before you push. A red
commit reached `main` on 2026-09-01 on exactly that gap.

**`pnpm test:changed` is the loop, never the proof** — it selects by import graph and says so on
every run. `pnpm test` before you push, always.

Every other command is a `package.json` script — `pnpm run` in a package lists its own, turbo fans
the shared ones out from the root, and `packages/runner` is cargo. Read them there, not here.

## Every gate, seven axes

Every gate blocks the merge from `ci-passed`, and **that, not this file, is why they hold** — every
threshold, baseline and refusal is enforced by a checker `pnpm verify` runs, so none is restated
here.

Seven axes — form, knowledge, relations, behaviour, language, record, comment. Five own a property
of the code; `record` owns `CHANGELOG.md`, the external record of what shipped; `comment` owns what
a comment SAYS. An axis measures at its weakest gate, and `.forge/conformance.json` is where each
one's level, owner, reason and priced amnesty are declared.

The one rule no checker can enforce, because it is about where a NEW rule goes: **do not add a rule
to an axis another already owns.** Two axes measuring one property is how a threshold starts
disagreeing with itself.

Which gate owns what, the conformance levels and their baseline directions, and what each rule was
born from: **[`scripts/README.md`](scripts/README.md)**.

## Doing the work

**Take the complete fix and pay the larger workload for it.** Where a smaller change and a whole
one both close the issue, the whole one is the deliverable — effort is not a reason to defer
structural work, and a workaround that becomes routine is a defect. The bound is the ownership line,
named in the same breath because the two are one rule: no merging or reverting a shared branch, no
doing another issue's work, no silently overriding a human's decision. Everything inside that line
is yours whether or not it is in your AC; the first thing outside it is not, however cheap.

**A trade-off is priced or it is not taken.** `--update-baseline`, a waiver, a skipped test — each
is an amnesty, and an amnesty with no stated price is how a gate stops meaning what its row says.
Name what was traded, what it costs, and the condition that ends it: an undeclared trade-off is
indistinguishable from an unnoticed one six weeks later.
**Before you change behaviour, know what you are replacing.** Requirement, then the design, then
the old logic this supersedes, then the cleanup that removes it. Code that ships beside the thing
it replaced leaves two live paths and a reader who cannot tell which one runs.

**A loud break beats a silent substitution.** When a refactor cannot do what was asked, it must
fail where the gap is — never the nearest thing that still returns. Where the old path handled a
case the new one does not, refuse it by name: do not widen a filter to swallow it, do not fall back
to the path being replaced, do not delete the rows that no longer fit. An operator told
`no SSH provider for this repo` loses ten minutes; one whose job silently ran against a different
checkout loses the diff. A migration obeys the same rule — a row the new schema cannot represent
aborts the deploy naming that row, rather than being cleaned away so the `ALTER` succeeds. Effort
is not the tiebreaker in reverse either: the smaller change that preserves a silent fallback is the
one whose bill arrives later and unlabelled.

**Wrong input is refused by name, not absorbed.** A caller who broke the contract gets told what
was wrong, where, and what shape is valid — the refusal IS the deliverable. Do not widen a schema
to accept the malformed value, do not guess the intent behind it, do not carry a compatibility
branch for a shape that was never legal. The way out is the interface, not the exception.

Three things wear that face, and only the first is the caller's:

- **A real contract break** → refuse by name, above.
- **A silence** → OURS, whoever typed the input. A call that returns `200` and does nothing, or an
  entry skipped *silently, forever* (ISS-807), is a defect on our side of the line. Fix it to fail
  loudly, and plant the malformed input to watch it go red before the fix counts for anything.
- **An affordance defect** → the wrong use IS the natural reading of the interface. One reader
  misreading buys a clearer error; the same affordance biting twice buys a redesign (ISS-1170), and
  "we will document it better" is how that redesign gets deferred a third time.

Which of the three you may absorb follows `VISION: kernel-hard-policy-soft`. Kernel input — job,
session, run, state, transition, evidence, retry, escalation — has zero tolerance: a
representable-looking wrong value there is how state starts lying. Policy input may normalize, but
an unreported normalization is a guess, and a guess is the silent substitution under a friendlier
name. A wrong use already load-bearing in the field is a priced amnesty named with its issue and
the condition that ends it — never a quiet accommodation.

### There is no "already red"

**A defect you have seen may not leave your hands labelled "not mine".** In reach and inside the
ownership line → **fix it, whoever caused it**, not only what you broke. Out of reach → it leaves
as someone's work by one of the routes `.forge/orientation.md` names, never as a new issue.

**Disclosure is not a discharge.** A step that names a defect and ships anyway is a failed step,
not an honest one — the failure mode is not dishonesty, it is honesty used in place of repair.
"Pre-existing", "untouched" and "out of scope" are reasons to **record**, never reasons to go
quiet, and never reasons to go green.

### The one carve-out: forge-plugin is reached by issue, never by diff

**A defect in github.com/SidCorp-co/forge-plugin leaves as an issue on the `forge-plugin`
project, and you do not edit that repo from a job in this one.** The `forge` CLI, the session
hooks and the issue-flow skill live there; a verb that refuses wrongly, a missing way out, a
skill naming something this repo no longer has — all of it files there and is named in your
comment under `Extra fixes:` as **reported**, not fixed.

This is the single exception to *fix-it-now*, and it is a boundary rather than an amnesty: the two
repos ship on different clocks, so a change landing there from here is one no gate here has seen
and no reviewer there asked for. The defect still leaves owned, by a row somebody can open —
which is exactly what `file-instead-of-fix` refuses everywhere else and requires here.

### An issue that does leave names the mechanism, not the symptom

**Where an issue is the right container — a residual out of reach, a `forge-plugin` defect — it is
written to the root cause or it buys nothing.** Three rules above bind the issue text, not only
the code:

- *Take the complete fix* decides the title: the deliverable is the mechanism, and the symptom is
  evidence attached to the issue, never its Outcome.
- *Plant exactly that, and watch it go red* binds it as much as a test. A fix that cannot be shown
  closing a reproduced failure is a guess with a commit message.
- `VISION: state-never-lies` does not stop at the code: a causal chain stated with its gap is a
  starting point, the same chain implied whole is a trap for whoever picks it up.

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
not one of the three. The pipeline's `forge-code` step decides which; `check-doc-citations` decides
whether it was entitled to say *still true*, and prints what it checked. Prose is the step's alone.

<!-- doc-citation: unchecked `file.ts:symbol` — the NOTATION being defined, not a file this repo holds. -->
Cite a doc claim so it can be checked: name the identifier or the `file.ts:symbol` anchor, never a
line number — a line number is stale the moment anything above it moves, and stale in silence.

## Invariants

- **A `pipeline_run` and its child `jobs` reach terminal together, in BOTH directions** (ISS-923).
  Defend one half only and the other leaks in silence.
  - *Forward — no child `jobs` row stays non-terminal under a terminal `pipeline_run`*: one orphan
    wedges a runner slot. Three defences in lockstep (close-cascade, loop monitor, pool exclusion),
    plus `held` as a deliberate fourth shape that is NOT an orphan.
    `packages/core/src/pipeline/runs-cascade.ts`, `packages/core/src/jobs/loop-monitor.ts`.
  - *Inverse — no `pipeline_run` stays non-terminal once every child job is terminal*:
    `packages/core/src/pipeline/runs-concluded.ts`, driven from the sweeper tick, closing on the
    LAST job's outcome so a run whose last job failed never closes `completed`.
  - New code that flips `pipeline_runs.status` terminal MUST route through a cascade-calling
    helper — on either axis, there is exactly one writer.
- **A migration's `when` in `packages/core/drizzle/migrations/meta/_journal.json` must exceed EVERY
  `created_at` already in the target DB.** Drizzle reads the single highest `created_at` once and
  skips lower entries **silently, forever**, so the container starts and serves new code against an
  old schema (ISS-807). **`node scripts/check-migration-order.mjs` prints the number to take** — its
  `Next free:` line is the only place to read one from, and the values are synthetic whole days,
  never a real timestamp. The subject is every open branch, not yours: branches each deriving
  `+86400000` from one `main` all land on the SAME number and whichever merges first silently kills
  the rest. The one thing no gate catches — a merge taken out of the order the checker derived — is
  in `scripts/README.md`.

Where the architecture is going, and what the tree does instead: `docs/proposals/destination/`.
