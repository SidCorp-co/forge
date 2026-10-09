@.forge/orientation.md

# Forge

**Constitution: [`docs/VISION.md`](docs/VISION.md)** — what Forge is / is not, why, who, and the
principles (incl. `VISION: state-never-lies`, `VISION: kernel-hard-policy-soft`). Intent only: no architecture,
no versions, no roadmap. On intent conflicts, VISION wins — cite it by name, never by section
number.

## Workspace

| Package | What |
|---|---|
| `packages/core` | Hono backend over Drizzle/Postgres, mounting every module's routes from `packages/core/src/route-registry.ts`; also the WebSocket server, the MCP server, and the job pool a master agent claims from. |
| `packages/web-v2` | Next.js cloud UI, canonical at `/`. Feature modules under `src/features/<domain>/`. |
| `packages/runner` | Headless Rust `forge-runner` CLI daemon for servers/CI; pairs as a device. |
| `packages/contracts` | Shared cross-app TS types & registries, under `packages/contracts/src/`. |
| `packages/observability` | Shared telemetry helpers (incl. the secret scrubber). |

## Commands

**A run tests its own scope, not the project** (`REQ-36`; owner, 2026-10-09: no sledgehammer for a
nut). Before coding, name the pattern each criterion reuses (`file:symbol`) or the new one you
propose, the modules and contracts you touch, and how you will prove each criterion. Prove it by
running it — start the service (core on a throwaway Postgres through the integration harness, or the
web dev server) and exercise the criterion's happy, negative and boundary cases — and keep the probe.
Then run `pnpm test:changed`: `pnpm tc:changed`'s typecheck and only the DIRECT tests of what you
touched, in every package — a test you touched, a test importing a file you touched, and a test
declaring `@direct-test-of <path>` over it; `--integration` adds the core integration tests chosen
the same way. It never follows the import graph further and never falls back to a whole suite. Not
the whole suites. Before you land on `dev`, `GITHUB_BASE_REF=dev pnpm merge-check` runs the same on
the change rebased onto the latest `dev`, with those integration tests and `pnpm verify` — the
conformance entrypoint — and refuses a branch behind its base (`MERGE_BEHIND_BASE`); record the
report it writes with `POST /api/issues/:id/merge-check`. The whole suite runs nightly and on each
release cut's commit. A red there that the merge check missed widens the selection — a
`@direct-test-of` line on the test that caught it — never the suite.

**A release is cut only on a commit whose whole suite is green.** `scripts/cut-release.sh` reads the
`whole-suite` check on its commit and refuses `RELEASE_SUITE_NOT_GREEN` otherwise; with none there
it starts one (`-f suite=whole`, about fifteen minutes) and waits for it, so a cut ends green or red.
A `whole-suite` check concluded `skipped`, which every other run leaves, is no record. A red one
names the merge that broke it in its `suite-bisect` job (ISS-471).

**The gate is CI, not your laptop.** `verify` declares the test suites and the build rather than
running them; CI runs them, and `main` takes no merge whose **`ci-passed`** is red — the one
required check.

**Four jobs run after the merge, not before it** — `core-integration`, `whole-tree`, `images` and
the runner's macOS and Windows legs run on every push to `main` and nightly, and `ci-passed` does
not need them (ISS-1370, priced in `.forge/conformance.json` `$postMerge`). A red there is fixed forward
by the next run to land: read `main`'s latest run before you push. To run them on a branch before it lands:
`gh workflow run CI --ref <branch> -f base=<the branch it lands on>`.

**On `dev`, a push and a pull request run the merge check and nothing else** — the `merge-check`
job (ISS-472, replacing ISS-118's skip): `pnpm merge-check` on a pull request's head against the
latest `dev`, or on a push over what it landed, and `ci-passed` needs it. Every other job skips
there. GitHub runs a schedule on the default branch alone, which is `main`, so no nightly run has
ever reached dev. `ci.yml`'s `nightly-fanout` starts dev's from `main`'s nightly run once this
file is on `main`; until then dev's whole suite runs when a release cut starts it.

**Green covers the jobs that RAN.** A skipped job passes `ci-passed`, and `changes` decides which
run: read which ran, not the aggregate alone. A suite the filter should have selected and did not
is the defect.

**`enforce_admins` is `false`** — an administrator can merge past red. Don't.

**A pull request is gated before it lands; a direct push to `main`, after.**

**What makes a run proof is where it ran.** On `dev` the core unit and integration suites and the
web suite are tracked again (ISS-172's QA phase; `pnpm --filter @forge/core test:integration` runs
every migration on a throwaway Postgres, `pnpm --filter web-v2 test` runs the web suite under jsdom),
nightly and before a release cut — not in each run, and not at a merge, where only the direct tests
run. The Rust tests remain.

**The builds do not typecheck** — `@forge/contracts` and `@forge/core` build with `--noCheck`.
`pnpm tc:changed` typechecks the packages your branch touched, and every package importing one,
against `origin/dev`.

Every other command is a `package.json` script — `pnpm run` in a package lists its own, turbo fans
the shared ones out from the root, and `packages/runner` is cargo. Read them there, not here.

## Every gate, six axes

Every gate but the four `$postMerge` names blocks the merge from `ci-passed`, and **that, not
this file, is why they hold** — every threshold, baseline and refusal is enforced by a checker
`pnpm verify` runs, so none is restated here. Six axes: form, knowledge, relations, behaviour,
language, record. `record` owns `CHANGELOG.md` and `changelog.d/`: an unreleased entry is its own
file, `changelog.d/<branch>.<section>.md`, never a line in `CHANGELOG.md`. An axis measures at its weakest gate, and
`.forge/conformance.json` declares each one's level, owner, reason and priced amnesty.

**Do not add a rule to an axis another already owns** — the one rule no checker can enforce,
because it is about where a NEW rule goes.

Which gate owns what, and what each rule was born from: **[`scripts/README.md`](scripts/README.md)**.

## Doing the work

**Take the complete fix and pay the larger workload for it.** Where a smaller change and a whole
one both close the issue, the whole one is the deliverable; effort is not a reason to defer
structural work, and a workaround that becomes routine is a defect. **The bound is the ownership
line** — no merging or reverting a shared branch, no doing another issue's work, no silently
overriding a human's decision. Inside it is yours whether or not it is in your AC; the first thing
outside is not, however cheap.

**A trade-off is priced or it is not taken.** `--update-baseline`, a waiver, a skipped test: each
is an amnesty, and it names what was traded, what it costs, and the condition that ends it.

**The Product leads, Delivery follows** (`VISION: requirement-leads-delivery`). The Product is
requirements, workflows, feedback and releases; Delivery is issue → pipeline → deploy → verdict. Work names the
requirement and criteria it delivers. Where the expectation is wrong or missing, revise the
requirement or workflow first, then build to it. Done means a named criterion holds on the running
build. Old code the work touches is cleaned inside that work.

**Before you change behaviour, know what you are replacing.** Requirement, design, the old logic
this supersedes, the cleanup that removes it — code shipping beside what it replaced leaves two
live paths.

### Refuse by name; never absorb

**A loud break beats a silent substitution.** A refactor that cannot do what was asked fails where
the gap is, never at the nearest thing that still returns: do not widen a filter to swallow it, do
not fall back to the path being replaced, do not delete the rows that no longer fit. A migration
aborts the deploy naming the row its new schema cannot represent. A smaller change is not preferred
for being smaller when it preserves a silent fallback.

**Wrong input is refused by name** — what was wrong, where, and what shape is valid. The refusal IS
the deliverable. Do not widen a schema to accept it, do not guess the intent, do not carry a
compatibility branch for a shape that was never legal.

Three things wear that face, and only the first is the caller's:

- **A contract break** → refuse by name.
- **A silence** → OURS, whoever typed the input: a `200` that does nothing, an entry skipped
  *silently, forever*. Fix it to fail loudly, and plant the malformed input to watch it go red
  before the fix counts.
- **An affordance defect** → the wrong use IS the natural reading. One reader misreading buys a
  clearer error; the same affordance biting twice buys a redesign, and "we will document it better"
  is how that redesign gets deferred again.

Which you may absorb follows `VISION: kernel-hard-policy-soft`. **Kernel input** — job, session,
run, state, transition, evidence, retry, escalation — has zero tolerance. **Policy input** may
normalize, but an unreported normalization is a guess. A wrong use already load-bearing in the
field is a priced amnesty named with its issue and the condition that ends it.

### There is no "already red"

**A defect you have seen may not leave your hands labelled "not mine".** In reach and inside the
ownership line → **fix it, whoever caused it**. Out of reach → it leaves as someone's work by one
of the routes `.forge/orientation.md` names, never as a new issue.

**Disclosure is not a discharge.** A step that names a defect and ships anyway is a failed step —
honesty used in place of repair. "Pre-existing", "untouched" and "out of scope" are reasons to
**record**, never reasons to go quiet or to go green.

**An issue that does leave is written to the mechanism**: the title is the root cause, the symptom
is evidence attached to it and never its Outcome. A fix that cannot be shown closing a reproduced
failure is a guess with a commit message, and a causal chain stated with its gap is a starting
point where the same chain implied whole is a trap.

### The one carve-out: forge-plugin is reached by issue, never by diff

**The driver skill lives in a second repo**, github.com/SidCorp-co/forge-plugin — the `forge` CLI,
the session hooks, and the issue-flow skill every `drive` job runs. It is a Forge project too
(`forge-plugin`, autonomous, pinned to a SHA). Nothing here can gate the pair: a change to the five
driver statuses, the drive prompt or the phase endpoints has a second half there, and nothing here
records the coupling.

**A defect there leaves as an issue there, and you do not edit that repo from a job in this one** —
a verb that refuses wrongly, a missing way out, a skill naming something this repo no longer has.
Name it in your comment under `Extra fixes:` as **reported**, not fixed. This is the single
exception to *fix-it-now*, and it is a boundary rather than an amnesty: the two repos ship on
different clocks, so a change landing there from here is one no gate here has seen and no reviewer
there asked for.

## Green is a claim about one proposition

**A green check is evidence for exactly one thing: that assertion held in the runtime that ran
it.** Where the runtime cannot represent the failure, a pass is not weak evidence — it is none. Ask
what would have to be true for the assertion to go red, **plant exactly that, and watch it go red
naming its own rule**. A test that cannot fail has not been written yet.

Cover the axes, not just the happy path: happy · negative · boundary · extreme/edge · the business
rule itself.

## Documentation is deleted, not carried

**Better no document than a wrong one.** A doc that cannot be verified is removed in the change
that discovers it — no deprecation note, no "may be stale" header. **Where a doc that describes
code disagrees with the code, the code is right**; fix the doc in the same change. **Approved
requirements and workflow designs are the other way round: they are the root, and code that
disagrees with them is drift** — marked and reconciled to the design, never used to rewrite it
(`docs/proposals/design-is-the-root-and-code-is-reconciled-to-it.md`).

**The files you read are your doc-review worklist.** Every `.md` you opened while working comes
back marked *still true* / *edited* / *deleted*; "did not touch" is not one of the three. The
run that read it decides which, and `check-doc-citations` decides whether it was entitled to say
*still true*.

**A proposal is deleted by the change that implements it.** Every `docs/proposals/*.md` opens with
a `**Removed when:**` line naming the issue whose landing deletes it; `check-honest-costs` refuses
one without.

<!-- doc-citation: unchecked `file.ts:symbol` — the NOTATION being defined, not a file this repo holds. -->
Cite a doc claim by identifier or `file.ts:symbol` anchor, **never a line number** — a line number
is stale the moment anything above it moves, and stale in silence.

## Invariants

- **A migration's `when` in `packages/core/drizzle/migrations/meta/_journal.json` must exceed EVERY
  `created_at` already in the target DB.** Drizzle reads the single highest `created_at` once and
  skips lower entries **silently, forever**, so the container starts and serves new code against an
  old schema. **`node scripts/check-migration-order.mjs` prints the number to take** — its
  `Next free:` line is the only place to read one from, and the values are synthetic whole days,
  never a real timestamp. The subject is every open branch, not yours: branches each deriving
  `+86400000` from one `main` all land on the SAME number and whichever merges first silently kills
  the rest. The one thing no gate catches — a merge taken out of the order the checker derived — is
  in `scripts/README.md`.

Where the architecture is going, and what the tree does instead: `docs/proposals/destination/`.
