# Where the time goes, and what may be cut without cutting what is proved

Writing the code is 15% of a run. This page measures the other 85% and says which parts of it are
waste, which are the price of the guarantees, and what each cut costs.

Nothing here proposes deleting a case, weakening an assertion, raising a limit or skipping a step.
Every cut below is about **how long a proof takes**, not about **what is proved**. The one cut that
does change which tests run says so in its own section and carries the safeguards that make it
honest.

## The measurements

**Run time.** 431 issue-flow runs, 2026-09-20T09:36Z to 2026-09-29T18:23Z, off `forge stats runs
--since 10d`. **28,219.4 minutes — 470 hours**, median 39.8 per run, longest 722. Every phase is
listed, so the column sums to the wall, to the rounding:

| phase | runs | median | sum | share |
|---|---|---|---|---|
| 0 Project | 430 | 1.5 | 3,196 | 11% |
| **1 Triage** | 408 | 6.4 | **6,455** | **23%** |
| 2 Clarify | 101 | 0.8 | 219 | <1% |
| 3 Plan | 87 | 2.8 | 682 | 2% |
| **4 Implement** | 179 | 7.9 | **4,372** | **15%** |
| **5 Prove** | 126 | 43.2 | **9,247** | **33%** |
| 6 Note | 163 | 0.5 | 110 | <1% |
| 7 Ship | 150 | 3.7 | 2,992 | 11% |
| 8 Clean up | 56 | 2.3 | 947 | 3% |
| **total** | | | **28,220** | **100%** |

A run passes through several phases, so the `runs` column does not sum to 431 and is not meant to.

Orientation — phases 0 and 1, everything before a line is written — is **9,651 minutes, 34%**. It
costs **more than proving** and more than twice implementing.

**CI.** One full run, 36602136404 — the push to `main` of the merge of #746, which paid the whole
gate because of the defect in cut 2 — by job in seconds:

    core-integration 1293 | core 222 | images 221 | web 211 | conformance 116 | whole-tree 52
    archmap 48 | docs 39 | install-check 20 | lang-check 15 | injected-docs 10 | changes 8

Non-skipped job time sums to 37.6 minutes against a **22-minute wall**. Every other job finishes
behind `core-integration`. **The wall is that one job**, and cutting any other saves nothing.

**Re-running.** Over the 24 hours to 2026-09-29T18:00Z: **34 CI runs for 14 merges — 2.4 runs per
landed change**, 11 of them paying `core-integration`, **5.1 hours** of CI wall. Worst single
branch: `ISS-1314-r4-fail-closed`, **6 runs to land once**.

**Reading.** 2,801 of 17,112 CLI calls in those runs were `-h` reads — **16%**, in 426 of 431 runs,
median 6 per run. The served surface is 283,536 characters over 149 texts, of which **16,840
characters are lines printed by more than one text** (`forge stats surface`).

## Cut 1 — the integration suite runs one file at a time

**ISS-1338.** `core-integration` is 98% of CI's wall and runs its 225 files through a single worker,
because `maxWorkers: workers(4, { cap: 3 })` computes `floor(cores / 4)` and a GitHub runner has 2
or 4 vCPU. Eight cores would be needed before that expression yields 2.

The cap is right for what it was written for — its comment says a 12-core developer box hit load
average 27 because turbo fans packages out together. On CI the job is alone on its own runner.
`VITEST_MAX_WORKERS` exists as an override and is set nowhere in `.github/`.

The suite is built for parallelism: `tests/helpers/global-setup.ts` applies the migrations once into
a template database and each test mints its own scratch database from it, per case and per file. No
two workers share a database.

**This is the largest single lever measured and the cheapest to take.**

## Cut 2 — the same tree is gated 2.4 times per landed change

`strict: true` means a branch cannot merge while it is behind, so every landing puts every other
open PR behind and each must be brought up to date and re-gated. ISS-1203 measured this as roughly
`N^2/2` validation cycles for N landings.

Part of it was meant to be solved already. A push to `main` whose commit has two parents is
supposed to set `proved=true` in the `changes` job so the expensive suites skip, because a
pull_request run already proved that tree. Until ISS-1340 it never fired: the step counted parents
with `git rev-list --parents -n 1 HEAD` in a depth-1 checkout, where the shallow graft leaves every
commit with no parents, so the count was 1 and `proved` was `false` for every merge. Of the 29 push
runs on `main` in the two days to 2026-09-29T17:43Z, **11 paid the full gate, median 19.6 minutes,
and every one of those heads is a merge commit.**

The step now reads three things and needs all three: two parents off the commit object's header, a
tree equal to the second parent's, and that parent's latest `ci-passed` concluded `success`. The
last is what a parent count could not see — a merge taken past red with an administrator's
override carries two parents too. `scripts/lib/proved-step.test.mjs` runs the step's own shell in
depth-1 clones. What it saves is read off the first merge push after it lands, not off this page.

The release train is the remaining half: validate one combination once instead of re-validating each
member every time the base moves. `docs/proposals/release-train.md` holds its logic, ISS-1203 builds
the mechanism.

## Cut 3 — proving happens inside the run that built the change

This is the release train's actual purpose, and it is the one most easily misread — including by the
runs adopting it.

A builder run today does implement **and** prove: median 7.9 minutes of writing followed by a median
43.2 minutes of proving, holding one runner slot throughout. Measured on 2026-09-29, five subagents
were out at once with three of them labelled `Rerunning` or `Rechecking`, two of those past two
hours.

The train is not primarily a way to share gate minutes between members. **It is a role split**: the
builder ends when the change is built (`in_progress` at its `test` step, ISS-54) and hands the slot back; proving over the whole product is another
role's. A window of one member still delivers that, which is why "a window of one saves nothing" is
the wrong test — it measures gate minutes and misses the slot.

`at: developed` is the only rung where the 43 minutes is still unspent, which is why the train forms
there and nowhere else.

## Cut 4 — a third of a run is spent arriving

9,651 minutes went to phases 0 and 1 before any implementation — more than proving costs. Inside
Triage alone, 244 `test` calls spent 464 minutes, in a phase whose question is what an issue *is*.

Three measured contributors, each cuttable on its own:

- **Help re-read per run.** 16% of all CLI calls are `-h`, median 6 per run, in 426 of 431 runs.
  What an agent re-reads every run is a candidate for being in front of it once.
- **A surface that repeats itself.** 16,840 characters are printed by more than one text — 47 lines,
  192 printings past the first. `forge guide issue-flow` alone is 29,461 characters and was read 221
  times.
- **Tests inside Triage.** Some are honest: saying "already fixed" without running the reproduction
  is a guess. 464 minutes says more than that is happening.

This is the largest share of the total and the least examined. It deserves its own measurement pass
before a number is put on what it should cost.

## Cut 5 — the integration suite has no selection at all

The repository already selects elsewhere: `pnpm test:changed` selects by import graph, and CI's
`changes` job decides which suites run at all. Inside `core-integration` there is no selection —
all 225 files run on every code change, whatever it touched.

Prior art, with its numbers and its source: Aditya Anchuri, *Selective Test Execution at Stripe:
Fast CI for a 50M-line Ruby monorepo*, published 2026-04-09, read 2026-09-30 —
<https://stripe.dev/blog/selective-test-execution-at-stripe-fast-ci-for-a-50m-line-ruby-monorepo>.
It reports running **roughly 5% of the Ruby suite per build, under 0.5% in at least half of
builds, for under 10% of the compute** of running everything, over roughly 100,000 test files, 1.2
million test units and 50,000 builds a week. The mechanism: an `LD_PRELOAD` shared library records
every file a test opens at the syscall level, a scope stack attributes each access to a test, and
roaring-bitmap indexes map changed files to impacted tests.

**Those are Stripe's measured results on Stripe's corpus, not a forecast for this one.** Their
ratio comes from a suite two orders of magnitude larger, in a dynamic language where static
analysis fails outright — which is why they intercept syscalls at all. This repository is
TypeScript with a resolvable import graph and 225 integration files. What this project would save
is unmeasured, and cut 5 must not be costed off their number.

**Their safeguards are the part to copy, not the percentage.** Tests that glob a directory always
run, because a new file produces no access signal. Tests that failed last time always re-run until
they pass. A change to a root-scope file runs everything. The post publishes no miss rate or
escaped-defect rate, which is itself worth knowing before trusting a number.

This is the only cut here that changes which tests run, so it is the only one that can be wrong in a
way the others cannot. It is listed last deliberately: cuts 1 to 4 take time out of the system
without touching what is proved, and their result should be measured before anything selects.

## What is deliberately not cut

- **Any assertion, case, limit or step.** These are the four moves the contract refuses, and no
  measurement here argues for one.
- **The jobs that are not the wall.** `conformance`, `archmap`, `docs`, `lang-check`,
  `injected-docs`, `install-check` and `whole-tree` together are under four minutes and finish
  behind `core-integration`. Cutting them saves nothing and costs what they catch.
- **`proved=true`'s exclusions.** The cheap always-on jobs are ungated by paths-filter on purpose,
  and `docs` walks the whole tree so a merge can break a link no PR run saw.
- **Per-file database isolation.** It is what makes cut 1 safe, and a suite whose workers shared a
  database would be a worse suite that happened to be faster.

## Honest costs

| What taking these costs | The price |
|---|---|
| Higher concurrency surfaces order dependence | A suite that has only ever run one file at a time has never been asked whether its tests are independent. Raising workers will find the ones that are not, and each is a real defect to fix rather than a reason to lower the number back. Budget for finding some. |
| A parallel run is harder to read when it fails | Interleaved output from several workers costs more to diagnose than a serial log, every time a run goes red, for as long as the suite is parallel. |
| The role split makes one change slower end to end | A builder that stops once the change is built hands it to a queue, so that change waits longer before it lands than it does today. What improves is slot turnover and cost per landed issue; anyone judging by how fast one issue felt will read this as a regression. |
| Measuring orientation costs a pass nobody has budgeted | Cut 4 is the biggest share and the least understood. Putting a number on it means instrumenting what a run reads and why, which is work that produces no landed change. |
| Selection needs an index, and an index needs upkeep | Cut 5 has the largest published ratio behind it and brings a second artefact that can be stale, wrong, or silently incomplete. A stale index is worse than no selection, because it is trusted. |
| Fixing `proved` stops `main` re-proving merges | A merge taken past red is not the risk: the step reads the second parent's `ci-passed` and keeps the full gate unless it concluded `success`. What remains is that a flaky or environment-dependent failure the pull_request run happened to pass loses the second draw a merge push used to give it, for as long as merges skip the suites. |
| Every number here ages | These are one window: 431 runs over nine days and 24 hours of CI. The shape will hold longer than the figures. Re-measure before acting on a figure rather than citing this page. |

## Scope

forge-dev. The measurements are this project's own corpus and this repository's CI; the shape may
generalise, the numbers do not.
