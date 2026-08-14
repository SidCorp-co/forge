# Adopt conformance on a repo

How to take a repo from "no gates" to "one axis that actually blocks a merge", then repeat.
Written for a maintainer setting this up on **any** repo — this monorepo is only the worked example.

**Prerequisites:** a git checkout, `node` ≥ 20, and CI you can edit. Nothing else — no plugin,
no global install.

> The rules this guide implements, and why each exists, are in
> [`../../CLAUDE.md`](../../CLAUDE.md#seven-gates-five-axes). This file is the how.

## What you are building

Conformance owns **no checker**. `cm` and `arch` are standalone tools with their own configs and
CLIs; biome, vitest, tsc and phpunit are third-party. What you are building is the layer that turns
them into one platform.

| Piece | Lives | What it does |
|---|---|---|
| `scripts/check-*.mjs` | your repo | one checker per axis — measures one thing, exits `0/1/2` |
| `scripts/verify.mjs` | your repo | runs them all, one table, enforces fail-closed |
| `.forge/conformance.json` | your repo | declares each axis's level + per-checker config |
| `.forge/*-baseline.json` | your repo, machine-generated | today's debt, frozen |
| a CI job | your workflow | the only thing that can block a merge |

**The unit of work is one axis, not "a conformance system".** Six steps below, about half a day.
Then repeat for the next axis. Axes are independent — adding one cannot break another.

Four things the layer supplies that no single tool can. The first three are plumbing; the fourth is
where it stops being a task runner — see [step 8](#8-join-two-axes--where-the-platform-pays-off).

| | |
|---|---|
| **One exit contract** | `0/1/2` across every tool, so "could not run" is never read as "clean" |
| **One manifest** | what is defended and at what level — readable by a human, an agent, or a fleet view |
| **One advisory surface** | `cm`'s guards reach a contributor with **no plugin installed**, because `verify` pulls them |
| **Joins** | facts that exist only when one tool's declaration meets another tool's measurement |

## What the repo gets

Measured on this repo, not projected:

| | |
|---|---|
| **Debt stops growing** | biome had drifted to 366 errors, typecheck to 84, the two length rules to 143. Each stopped drifting the day it was baselined and gated. The gate does not clean the 143 — it makes the 144th impossible |
| **"Already red" stops being an exit** | five pipeline runs merged on *"lint remains red only on pre-existing, untouched diagnostics"* while a required check was red and a regression suite had never run anywhere. Nobody lied; nobody fixed it |
| **One command, bare checkout** | a contributor with no plugin and an agent with no hooks are held to the same bar |
| **Declared knowledge reaches the editor** | `verify` prints the `cm:guard` / `cm:edge` on the files you changed. Without it those invariants are invisible until somebody breaks one |

The agent-facing version of the last two matters more than it looks: where agents write most of the
code, a green that is not true is not a missed defect — it is a **wrong instruction, repeated**.

## The one rule everything rests on

> **A check that cannot run must never report clean.**

Three exit codes, not two:

| Exit | Means | You do |
|---|---|---|
| `0` | clean | push |
| `1` | violations | fix the **code**, run again |
| `2` | **could not run** | fix the **gate** — never read this as a pass |

Ordinary linters have only "clean" and "dirty". The whole value of this setup is the third state.

---

## 1. Pick one axis

An **axis** is a concern with exactly one owner. Start with whichever is cheapest to measure in
your stack — you are proving the loop works, not covering everything.

| Axis | Owns | Typical tool |
|---|---|---|
| form | formatting, lint rules, file/function length | biome · eslint · pint · ruff · rubocop |
| knowledge | couplings no analyser can derive | codemap · your own checker |
| relations | which module may depend on which | archmap · dependency-cruiser · deptrac |
| behaviour | whether a test asserts behaviour, whether flows are walked | your own checker |
| language | source-language policy, banned strings | your own checker |

Do **not** put two owners on one axis — two configs on one rule drift apart.

## 2. Get the measurement out of a tool

Your checker's only job: turn a tool's output into `(file, rule, number)`, compare to a baseline,
exit `0/1/2`. Three shapes, all fine:

```bash
# a) tool already emits JSON — parse and filter
npx biome check src --reporter=json           # → filter to the rules you own

# b) tool emits another format — adapt it
phpstan analyse --error-format=json
vendor/bin/phpunit --coverage-clover clover.xml

# c) no tool exists for this rule — measure it yourself
#    (then YOUR checker owns the threshold, and it goes in conformance.json)
```

Copy a working checker as your starting point:
[`check-size-budget.mjs`](../../scripts/check-size-budget.mjs) (wraps a tool) or
[`check-source-language.mjs`](../../scripts/check-source-language.mjs) (measures directly).

Put the repo-specific knowledge — paths, thresholds, regexes — in `.forge/conformance.json`, not in
the script:

```json
{
  "checkers": {
    "size-budget": {
      "provider": "biome",
      "scopes": [{ "cwd": "packages/core", "args": ["check", "src", "tests"] }]
    }
  }
}
```

Two checkers in this repo were ported to a Laravel/PHP repo **by editing this file only** — no code
change. That is the test of whether you put the knowledge in the right place.

## 3. Prove the three exit codes — before anything else

This is the step people skip, and skipping it is how you end up with a gate that gates nothing.

```bash
# clean tree
node scripts/check-<axis>.mjs --all                    # expect 0

# introduce one violation
<make the smallest possible violation>
node scripts/check-<axis>.mjs --all                    # expect 1, naming the file

# point its scope somewhere empty
<edit scanRoots in .forge/conformance.json to a path with no matching files>
node scripts/check-<axis>.mjs --all                    # expect 2, NOT 0

# corrupt the config
echo '{' > .forge/conformance.json
node scripts/check-<axis>.mjs --all                    # expect 2, NOT 1
```

If the third command returns `0`, your checker is worse than nothing — it will report clean forever
the day someone moves a directory. Every fail-open bug this repo has shipped is that shape.

## 4. Freeze today's debt

You are not cleaning the repo. You are stopping it getting worse.

```bash
node scripts/check-<axis>.mjs --update-baseline
git add .forge/<axis>-baseline.json
```

The baseline needs three properties or it is only a snapshot:

| Property | Why |
|---|---|
| keyed by **content**, not line number | a reflow or a moved function is not a violation |
| declares which **kinds** of violation it froze | freezing kind X and then reading zero of X means the rule stopped firing — that must exit `2` |
| declares the direction of **"improves"** | size = fewer lines; test-signal = lower ratio; coverage = fewer uncovered steps |

Re-freeze with `--update-baseline` when growth is legitimate. The one-line change shows up in the
diff — that visibility *is* the escape hatch working, not a smell.

## 5. Wire it into one command

Add an entry to `CHECKS` in [`../../scripts/verify.mjs`](../../scripts/verify.mjs):

```js
{
  axis: 'form',
  label: 'size-budget',
  cmd: ['node', 'scripts/check-size-budget.mjs', '--all'],
  scanned: /^size-budget: (\d+) file/m,   // ← proof it scanned something
}
```

`scanned` is mandatory. It is how the runner distinguishes "no violations" from "I looked at
nothing" — a count of zero becomes exit `2`, not a pass.

```bash
pnpm verify        # one table, every axis, no early exit
```

## 6. Wire it into CI — both halves

A check that runs is not a check that gates. In GitHub Actions both of these are required:

```yaml
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: ./.github/actions/setup-workspace     # only if your checker needs deps
      - run: node scripts/check-size-budget.mjs --all

  ci-passed:
    if: always()
    needs: [ ..., conformance ]                     # half 1: listed
    steps:
      - run: |
          for r in \
            "conformance:${{ needs.conformance.result }}"; do   # half 2: ASSERTED
            ...
```

`ci-passed` runs `if: always()`, so a job listed in `needs` but absent from the result loop
completes, is ignored, and **cannot fail the gate**. This repo had `archmap` in exactly that state
while documenting it as the relations gate — measured 2026-08-13. `verify --ci-parity` now fails on
the mismatch.

If your checker needs `node_modules`, put it in a job that installs them. A checker that cannot find
its tool exits `2` — correct behaviour, wrong job.

## 7. Declare the level — last

```json
{
  "axes": {
    "form": { "level": 2, "gate": "check-size-budget", "owns": "file & function length" }
  }
}
```

| Level | Means | Precondition |
|---|---|---|
| `0` | no checker | — |
| `1` | measures, does not block | none — **every repo starts here** |
| `2` | baseline the old, block the new | the checker is in a job that actually blocks a merge |
| `3` | zero violations, no baseline | the axis is genuinely at zero |

**A repo with no CI cannot honestly declare anything above `1`.** Declaring `2` where nothing blocks
is the exact lie this whole setup exists to prevent, and
[`conformance-status.mjs`](../../scripts/conformance-status.mjs) will catch it — it measures by
*running* every checker, never by reading the manifest back.

Stopping at level 1 forever is not a failure. You still get a number you did not have.

---

## Verify it worked

```bash
pnpm verify                              # expect: your axis listed, non-zero count, exit 0
node scripts/conformance-status.mjs      # expect: declared == measured for every axis
node scripts/verify.mjs --ci-parity      # expect: every CI step declared, every needs job asserted
```

Then the real test — open a PR that violates your axis and confirm **CI turns red**. Until you have
seen that, you have a script, not a gate.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `scanned 0 files — a scope nobody could compute` | `scanRoots` resolve nowhere from the cwd the checker ran in | resolve paths from the script's own location, not `process.cwd()` |
| `<tool> output was not JSON` | the job has no `node_modules` / the tool is not installed | move the check to a job that installs deps |
| `the baseline records <kind> violations but this run found none` | the rule stopped firing (renamed, re-categorised, disabled) | check the rule id in your linter config; re-freeze only after confirming a genuine cleanup |
| `<n> job(s) in ci-passed.needs that ci-passed never asserts` | job listed but not in the result loop | add it to the loop — listing is not gating |
| CI step exists that `verify` neither runs nor declares | drift between the local command and the workflow | add it to `CI_COVERAGE` in `verify.mjs` |
| adding a `cm:` annotation trips the size budget | the file was already at its frozen length | `--update-baseline`; the +1 line in the diff is the intended record |

## 8. Join two axes — where the platform pays off

Steps 1–7 give you N independent gates run from one command. That is worth having, and it is still
only a task runner. The return on having them all in one place comes from **joins**:

> A fact that **no tool has on its own**, because it needs tool A's declaration matched against
> tool B's measurement.

The worked example in this repo is `check-flow-coverage.mjs`:

| | knows |
|---|---|
| `cm` | which line is **step 4 of the `dispatch` flow** |
| istanbul / v8 coverage | which lines **ran under the integration suite** |
| **neither** | **a declared flow step that nothing executes end-to-end** |

Notice why the join cannot live inside either tool. `cm` must not learn your coverage format — it
would then have to learn every coverage format. Your coverage tool must not learn what a "flow" is —
that concept does not exist outside `cm`. The fact is orthogonal to both, so it belongs to the layer
that already holds both. **That orthogonality is the test for whether something is a join at all.**

### How to build one

1. **Name the fact first**, in one sentence, and check no single tool can already answer it. If one
   can, add the rule there instead — a second owner on one rule is the drift this system forbids.
2. **Get both sides in machine form.** Declaration side: `cm graph --json`, `cm flow --json`,
   `.arch.json`, your manifest. Measurement side: coverage JSON, `git diff --name-only`, a linter's
   `--reporter=json`, an issue tracker's API.
3. **Cross-check the two counts against each other.** `check-flow-coverage` takes the step *sites*
   from `git grep` but the step *count* from `cm flow`, and exits `2` when they disagree — because
   re-parsing another tool's annotations duplicates its parser, and the only safe way to keep a copy
   is to make the tool audit it every run.
4. **Decide what an absent input means.** A join has more ways to not-run than a plain checker: a
   missing report, a stale report, an empty diff. Each is exit `2`, and the message must name which
   side was missing and how to produce it.
5. **Baseline the join separately.** `flow-coverage` freezes uncovered steps in its own file, so
   declaring a *new* flow is never punished — only made visible.

### Joins worth building, and what each catches

| Join | Declares | Measures | Catches |
|---|---|---|---|
| `flow-coverage` ✅ live | `cm:flow` step | integration coverage | a flow step nothing walks end-to-end |
| **lockstep-in-diff** | `cm:edge lockstep` | `git diff` vs merge-base | one half of a pair changed, the other untouched |
| guard-coverage | `cm:guard` | coverage | an invariant no test exercises |
| edge × architecture | `cm:edge` | `.arch.json` `forbidden` | a coupling that is real **and** illegal |
| hack expiry | `cm:hack ISS-<n>` | issue status | a workaround still in the tree after its issue closed |

**`lockstep-in-diff` is the cheapest and the highest-value one unbuilt.** Both inputs already exist,
and `cm` deliberately cannot own it: `cm` has no business knowing your PR's scope, your merge-base,
or which CI job blocks. This repo has 49 lockstep edges among 150 declared — for example the three orphan-hygiene
defences that must move together — and today nothing checks that a PR touching one touched the
others.

Do not build any of these before you have two axes at level 2. A join over a gate that does not
block is a report nobody acts on.

## Add the next axis

Repeat steps 1–7. Nothing from the first axis needs revisiting.

Once you have three or more, add the two meta-checks — without them the gates rot silently:

| Meta-check | Catches |
|---|---|
| `conformance-status.mjs` | an axis whose declared level no longer matches what its checker does |
| `verify --ci-parity` | a CI step `verify` does not run, and a `needs` job `ci-passed` never asserts |

Both are cheap and both have caught real regressions in this repo within days of being written.

## What this does not give you

- **Correct code.** Every finding this setup has produced was a declaration that was not true — none
  were logic bugs.
- **Less total work.** It moves work earlier and adds a baseline-maintenance tax.
- **Anything, if you skip step 3 or step 6.** A checker whose empty scope returns `0`, or a job
  nobody asserts, is decoration.

## Related

- [`../../CLAUDE.md`](../../CLAUDE.md#seven-gates-five-axes) — the axis table and the rules each gate owns
- [`../../scripts/README.md`](../../scripts/README.md) — what each checker in this repo measures
- [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) — where `pnpm verify` sits in the contributor loop
