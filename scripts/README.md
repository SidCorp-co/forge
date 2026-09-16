# scripts/

Project-level utilities. Each script has a comment header explaining its contract. A checker whose verdict is worth testing keeps that half in `lib/` — the CLI spawns, reads the tree and exits, none of which a test can call.

## Thirteen gates, six axes

Each gate sits in `ci-passed`'s `needs` **and** is named in its result loop. Both halves are
load-bearing: `ci-passed` runs `if: always()`, so a job listed in `needs` but absent from the loop
completes, is ignored, and cannot fail the gate. `archmap` was in exactly that state — measured
2026-08-13, documented as the relations gate the whole time it could not block anything.
`verify --ci-parity` now fails on the mismatch.

Every gate that drifted did so while documented and non-blocking — biome to 366 errors, `typecheck`
to 84, the two length rules to 143 — and each stopped drifting the day it was baselined and gated.

**An axis measures at its weakest gate.** Reporting the strongest would let one locked checker hide
a sibling that stopped blocking, which is the whole failure mode here. `form` is gated six times
(biome for `core`'s rules · `check-size-budget` for the length baseline biome cannot hold ·
`check-lint-budget` for `web-v2` and `core` · a bare `biome check scripts` for the checkers themselves ·
`check-provider-literals` for where an integration provider may be named · `check-integration-declarations`
for whether each provider declares the fields the generic paths read),
`behaviour` three times (reachability · signal · flow coverage) and `knowledge` three (honest
costs · the mode-qualification of injected docs · the PAT permission surface).

**`record` is the axis that was missing.** The other five each own a property of the code, and on
2026-08-28 commit `3df9a8e9` removed 1,034 lines from `CHANGELOG.md` inside a commit about dangling
docs pointers whose message never named the file. Every gate above ran on that change and every one
passed, because the external record of what shipped belonged to none of them.

| Axis | Gate (CI job) | Owns | Must not touch |
|---|---|---|---|
| format + lint | `biome check … --max-diagnostics=none` — `core` | whitespace, import order, recommended rules | comment content |
| size | `check-size-budget` — `conformance` | file & function length, frozen per file | which rules exist — biome declares them |
| lint debt | `check-lint-budget` — `conformance` | per (file, rule) biome violations in `web-v2` and `core`, frozen; drained on touch where a scope asks for it | which rules exist — each package's `biome.json` declares them |
| checkers | `biome check scripts` — `conformance` | the files in `scripts/` that implement every other gate | anything under `packages/` |
| provider literals | `check-provider-literals` — `conformance` | whether a provider's name (`coolify`, `postman`, …) is written outside the locations `.forge/conformance.json` allows WITH a reason: that provider's own directory, the registry, the schema and contracts vocabularies | whether a name allowed there is USED correctly; and `agent`, which this repo also spells as an actor, an author and a principal — excluded by name, with its reason and its retirement condition printed on every run |
| declarations | `check-integration-declarations` — `conformance` | whether every provider in the live registry carries the capability, schema and agent-path fields the generic paths read — including a non-empty `justification` on a `direct-mcp` arm, since that arm puts a project's credential on a runner box | which archetype a provider SHOULD be — that is the declaration's author's, and review's |
| injected docs | `check-injected-doc-modes` — `injected-docs` | that a status transition in a guide body or a mandatory fact names the pipeline mode it belongs to | whether the prose around a qualified transition is true; a project's own knowledge entries, which live in the DB |
| PAT surface | `check-pat-surface` — `injected-docs` | whether every route a project-scoped token can reach is covered by the permission menu that claims to fence it | whether a given fence is correct — that is review's |
| costs | `check-honest-costs` — `lang-check` | whether `docs/VISION.md` and every `docs/proposals/*.md` price what adopting them costs | whether the price stated is honest — that is review's |
| relations | `archmap check` — `archmap` | which module may depend on which | how a file is written |
| reachability | `check-test-reachability` — `conformance` | whether every tracked test file is collected, and whether a skipped suite says why | what a test asserts once it runs |
| behaviour | `check-test-signal` — `lang-check` | whether a test asserts behaviour or restates a declaration | how many tests exist, coverage % |
| flows | `check-flow-coverage` — `core-integration` | whether the integration suite ENTERS the function every declared `cm:flow` step sits on | whether the flow ran through it — a function-hit cannot tell; which flows exist, `checkers.flow-coverage.flows` declares |
| language | `check-source-language` — `lang-check` | English-only source policy | everything else |
| record | `check-release-record` — `lang-check` | whether `CHANGELOG.md` keeps the heading its five readers parse for, and whether a published entry can leave without a declared reason | whether an entry is TRUE, or whether a change deserved one — that is review's |

### Why `core` lint prints every diagnostic

`--max-diagnostics=none` is not verbosity, it is the difference between a gate that names its
failure and one that names a bystander. biome truncates at 20 by default and orders by path, not by
severity, so with 399 baselined warnings in `packages/core` the one ERROR that fails the build is
simply not printed. Measured 2026-08-31: a planted format error in `src/ws/server.ts` produced
`Found 2 errors.` and **zero** mentions of that file, while the visible diagnostics all pointed at
`src/agent-sessions/chat-turn.test.ts`, which was clean and untouched.

`check-lint-budget` already defended against exactly this — it invokes biome with
`--max-diagnostics=5000` because truncation would silently empty its input. The blocking lint step
had no such guard. The two now agree.

### Conformance levels

`.forge/conformance.json` declares each axis's level — `0` no checker · `1` measures, does not
block · `2` baseline the old, block the new · `3` zero violations. Today: form 2 · knowledge 2 ·
relations 2 · behaviour 2 · language 3 · record 3.

Level 2 is the claim *"old debt frozen, new debt blocked"*, so each such axis must also name where
its debt is frozen and which direction improves it — `baseline: {path, keyBy, improves}`, where
`improves` is `down` (a per-key number may only fall), `shrink` (a set may only lose members) or
`tighten` (a status may only get stricter). The direction lives in the manifest, not in the
baseline file, because `--update-baseline` rewrites those files and a rule a re-freeze can silently
drop is not a rule.

The manifest also declares a `profile` — the shape the whole repo claims, never the tools it uses:
`baseline` one axis measures · `standard` two axes block and both meta-checks are present ·
`hardened` every declared axis blocks and every `ci-passed` needs-job is asserted. Today: hardened.

### Why reachability is prior to behaviour

`check-test-signal` scopes itself to what a runner collects, so it measured 493 files while
`packages/tests` held 64 that no runner collected — a checker cannot see what it is not given.
Frozen at zero on 2026-08-25, the one day it cost nothing: 495 tracked test files, 495 collected.
Declared skips live in `.forge/test-skips.json` with a reason each, because *"waiting on ISS-214's
endpoints"* is what the device-runner E2E said for months after those endpoints shipped.

### Why flows is where the two axes meet

A `cm:flow` annotation says *which line is step 4 of the dispatch flow*; the integration suite's v8
report says
*which lines ran*. A step named in the map and executed by nothing is a step the next editor
believes is defended. **A step reached only by unit tests does not count** — with 974 `vi.mock`
calls in `packages/core`, a unit test can run a step's function with every neighbour stubbed, which
proves the function runs, not that the flow connects. Nothing is self-reported: a
`// covers dispatch/tick` comment in a test file would be the claim-instead-of-measurement the
manifest exists to catch.

### Why lint debt and size are their own rows

**The drain half does not arm on a direct-to-`main` commit.** A touched file in a draining scope must
come back strictly under its baseline — but the scope is computed from the branch delta, and on
`main` the merge-base IS `HEAD`, so the run prints `drain skipped — no branch delta; freeze-only`
and only growth is checked. A change that lands straight on `main` (the owner lane) therefore never
sees a tier of this gate that a PR would fail on. `--update-baseline` cannot pay a drain either — it
re-measures and writes the same count back. Run `node scripts/check-lint-budget.mjs` from a branch,
or read the touched file's row in `.forge/lint-baseline.json`, before pushing to `main`.

`web-v2` had no biome config at all until 2026-08-23; measured on the day it got one, 748
diagnostics — 409 formatter, 185 import order, 151 real lint errors. `error` would have been 151 red
builds; `warn` would have held nothing. `check-lint-budget.mjs` freezes today's 216 violations
across 98 files per (file, rule) and fails only on growth — per rule rather than per line, so moving
code inside a file is not a violation. The formatter stays **off** there on purpose: enabling it is
a 313-file, 22k-line diff that would bury every real change under it.

Size is the same shape one package over. biome **declares** the two length rules but cannot gate
them: it has no baseline, so the only choices were `warn` (143 violations, exit 0, nothing held) and
`error` (every build red). `check-size-budget.mjs` reads biome's own JSON, freezes today's offenders
per file, and fails only on growth. It adds no rule — `packages/core/biome.json` still owns the
thresholds.

### Declared severity downgrades

`packages/core/biome.json` carries one `overrides` block, scoped to `**/*.test.ts` and
`**/tests/**`: `correctness/noUnsafeOptionalChaining` drops to `warn` (41 sites) and
`suspicious/noThenProperty` goes `off`. The first is the `expect(call).toBeDefined()` then
`call?.[1]` idiom, where the optional chain is asserted safe one line above; the second is Drizzle's
thenable query builder. Both are downgrades of rules the preset makes errors, so they belong in this
accounting rather than only in the config — an undocumented severity downgrade is how an axis stops
meaning what its row says. Measured 2026-08-25.

### Do not add a rule to an axis another already owns

- **No ESLint.** biome >= 2 covers `noExcessiveLinesPerFunction` and `noExcessiveLinesPerFile`,
  which is the whole reason ESLint would have been added. A second linter on the same axis means two
  configs drifting apart.
- **No comment rules at all.** A density or run-length rule cannot tell documentation from noise:
  the 19-line `/** */` block on `failReconcileRunIfNoVerdictRecorded` is documentation, and 19
  comment lines to a counter are not. The comment-grammar gate that used to own this axis was
  removed in ISS-1029 for that reason — it flagged prose that was right far more often than prose
  that was wrong, and a checker at that noise level teaches the reader to skip it.
- **No `biome.json` comments.** A comment inside it makes biome **silently ignore the whole
  enclosing block** — no config error, the `overrides` just stop applying. Put the reasoning in the
  commit message.

### archmap

`.arch.json` declares each contract `draft` or `locked`; `archmap lock <id>` (0.1.4) freezes that
contract's current violations into `.arch.baseline.json`, which is what lets a rule with existing
debt block the *next* violation instead of waiting for someone to fix all of them first. The last
`draft` contract, `no-coordinator-blob`, locked that way on 2026-08-25 with 13 frozen — so every
declared contract now blocks. That file is declared in `conformance.json` under `improves: down`,
because without a direction `archmap lock` is an amnesty button.

Exit codes: `0` clean · `1` a new violation · `2` **the gate could not run** (bad flag, unreadable
manifest, a scope matching no files). Never read `2` as a pass — it is the 1-vs-2 split every checker
here uses.

`.arch.json` declares `tsConfig: .arch-tsconfig.json`, and that line is load-bearing:
dependency-cruiser runs with `--no-config`, so without it nothing resolves through a tsconfig
`paths` alias — and an unresolvable edge is **dropped, not reported**. Measured 2026-08-23: 841 of
997 unresolvable edges were `web-v2`'s `@/*`, i.e. effectively that whole package's graph, while
three contracts over it sat `locked` and passed on nothing. With the map: 5,206 edges resolved, 170
unresolvable of 5,376 possible (3.2%) — all of them node_modules subpath exports, which belong to no
module. Audit rule R7 holds the ceiling, because `.forge/archmap/` is vendored and a re-vendor could
drop the support without a single test going red.

### Vendored checkers

**`.forge/` is committed, all of it.** archmap is vendored there (`.forge/archmap/`) and the CI job
runs that copy, so a contributor without a global install and the gate are held to the same reviewed
version — bump with `archmap install --force` and commit the result. `.forge/.gitignore` is the only place an exception may be declared,
and it carries the reason; a blanket `.forge/` in `.git/info/exclude` is a **local** rule teammates
never see, and it is why `orientation.md` went uncommitted for months.

The vendored shim must stay mode `100755` — `git ls-files -s .forge/archmap/archmap` to check. A shim
committed `100644` fails the job with permission denied, not with a violation.

## verify.mjs — the conformance entrypoint (`pnpm verify`)

Run it after you finish coding, before you push — same slot as `pnpm build`. It runs every
conformance check CI runs, in one pass, and reports all of them rather than stopping at the first.

Hooks are an accelerator, never the mechanism: Claude Code hooks need a plugin, git hooks need
`pnpm install` and an env without `SKIP_*`. Anything correctness depends on has to be reachable from
this script with nothing but a checkout and node.

Four contracts:

1. **CI parity** — every `- run:` and named step in `.github/workflows/ci.yml` is either run here or
   declared in `CI_COVERAGE` as covered by another root script. `--ci-parity` proves it and is itself
   a CI step, so the two cannot drift. It also proves the second half: every job in `ci-passed`'s
   `needs` is named in its result loop. `ci-passed` runs `if: always()`, so a job it needs but never
   asserts completes, is ignored, and cannot block a merge — `archmap` sat there while this repo
   called it the relations gate.
2. **Fail-closed** — each checker must emit a file count that this script can read, and a count of
   zero exits `2`, not `0`. A checker whose scope matched nothing reports "clean"; forwarding that as
   a pass is the failure mode this guards.
3. **Report everything** — no early exit. One fix cycle instead of six.
4. **Bounded width** — the checks run at a concurrency of 6 rather than all 20 at once, overridable
   with `VERIFY_CONCURRENCY`. Why 6 and not more was measured, and the measurement lives at the
   thing it decided: the `cm:why` on `verify.mjs:runAll`.

   This contract read **"Advisory — `cm impact` on every file changed against `origin/main` …
   the pull-side stand-in for the PreToolUse hook"** until 2026-09-17. `verify.mjs` has never run
   `cm impact`, in any version — the string appears nowhere in the file — so the sentence described
   an intention, and a reader who skipped the hook because the pull side "had it covered" was
   covered by nothing.

### One proposition per verdict

**A gate must distinguish "I ran and the code is wrong" from "I could not run", and a failure must
name which condition it represents.** They are answers to different questions — one is about the
repo, the other about the machine the gate is standing on — and a signal with no field for the
difference hands the reader the wrong one silently.

Five marks, each asserting exactly one thing:

| Mark | Means | Exit | Statement about |
|---|---|---|---|
| `ok` | ran, found nothing | 0 | the repo |
| `red` | ran, found violations | 1 | the repo |
| `FAIL` | ran, but its output could not be audited — no file count, or a count of zero | 2 | the repo |
| `n/a` | did not run: a declared prerequisite is absent. Names it and the command that installs it | 2 | this checkout |
| `skip` | did not run: absent locally by design, and CI provably runs it | 0 | this checkout |

`n/a` is not an amnesty. It exits `2` exactly as `FAIL` does, because an unrun gate is no evidence
and this script does not forward no-evidence as a pass — what changes is only the sentence a reader
gets. Prerequisites are declared per check as `needs:` and resolved against the **filesystem** by
`lib/prerequisite.mjs`, never against a tool's output text: a missing binary and a genuinely broken
import both print `Cannot find module`, and classifying by message would turn a real defect into
"could not run", which is this bug inverted and strictly worse because it goes green.

Preflight happens **before** the spawn. A checker run without its tool produces a sentence about its
own subject — `biome output in packages/core was not JSON`, `archmap: scope matched no files` — and
once that sentence exists nothing downstream can unsay it.

Measured 2026-09-07 in a worktree with no `node_modules`: `pnpm verify` reported `FAIL R7 the
relations gate can resolve the graph it claims to cover` and `conformance: claims "hardened" and
does not meet it`. Both accuse the repo; both were false; `archmap` and `tsc` were not on disk.
Nine checks were affected, not the two the report named. Unlike contention this survives a serial
re-run identically, so it wears the exact signature a reader is told to trust as a real defect
(ISS-938).

The run ends on a tally — `19 passed · 2 did not run · 1 red` — because the marks alone left the
reader to total twenty-two rows by eye, and the line that actually gets read is the last one. `skip`
and `n/a` are counted as **did not run**, never folded into `passed`: that fold is the exact merge
the five marks exist to prevent (ISS-955). The marks and the tally live in `lib/verify-report.mjs`
so both have a runner — `verify.mjs` executes its whole run at import and nothing inside it can be
unit-tested.

### Modes

- (none) — full run
- `--ci-parity` — only the parity proof; cheap, zero-dep, no install needed

Exit codes: `0` clean, `1` violations, `2` a check could not run.

## conformance-status.mjs — declared level vs measured level

`.forge/conformance.json` declares a level per axis; this runs each axis's checker and fails when
the two disagree. Levels are shared across axes: `0` no checker · `1` measures but does not block ·
`2` baseline the old and block the new · `3` zero violations, no baseline.

It measures by **running** the checker, never by reading the manifest back. Every gate this repo has
lost was lost the same way — biome to 366 errors, `typecheck` to 84, the two length rules to 143 —
each of them described as gating something for the whole time it gated nothing. A written level is a
claim; this is the check that tests the claim.

Also fails when an axis is declared with no probe, or probed with no declaration, so neither half can
drift out of the other's sight.

An axis whose probe is not on disk has **no measured level** — reported as `n/a`, compared against
nothing, and taking the script to exit `2`. Level `0` is not the answer there: `0` means "no checker
exists", a measured fact about the repo, and returning it for an absent binary reported three axes
as having lost their gates. `conformance-audit.mjs` draws the same line for `R7`, its one rule that
runs a tool: `n/a` rather than a rule this repo fails, and exit `2` before either profile verdict —
a `--` mark means the rule does not apply, `n/a` means it applies and was not answered.

## check-size-budget.mjs — file and function length

`packages/core/biome.json` owns both length rules; this owns only the baseline biome lacks. 102 files
are frozen in `.forge/size-baseline.json` — a file already over budget may stay over, it may not get
worse. Frozen per file (its length and its longest function), so a reflow or a moved function is not
a violation.

Adding a `cm:` annotation to a file already at its frozen budget will trip this. Re-freeze with
`--update-baseline`; the one-line growth shows up in the diff, which is how that escape hatch is
meant to be used.

### Adding a check

Append to `CHECKS` with a `scanned` regex matching that checker's own success line. Without one the
fail-closed contract cannot hold for it. If you add the step to CI too, add it to `CI_COVERAGE` in
the same commit — `--ci-parity` fails otherwise, which is the point.

## check-lint-budget.mjs — every biome diagnostic that is not a length rule, frozen per (file, rule)

Each package's `biome.json` owns the rules; this owns only the baseline biome lacks — the same split
as `check-size-budget.mjs`, which keeps the two length rules because it freezes them by line count.

It counts **every** diagnostic biome emits in a scope except the two length rules
`check-size-budget.mjs` owns — error severity included, and today 147 of web-v2's 210 frozen
diagnostics are errors. Severity decides only whether biome itself would have failed the build:
`error` meant red builds nobody could clear, and a severity biome exits 0 on (`warn`, `info`, or a
rule left at its default by `on`) held nothing. So both packages' debt is frozen per (file, rule) in
`.forge/lint-baseline.json` and only growth fails. Frozen per rule rather than per line, so moving or reflowing code inside a file is not a violation. Measured 2026-08-27: **487 violations
across 175 files** — web-v2 210 of an original 226 (95 files), core 277 of 280 (80 files, of which
53 diagnostics across 32 files are drainable).

`web-v2` had no biome config at all until 2026-08-23 — 748 diagnostics on the day it got one, 409
formatter, 185 import order, 151 real lint errors. The **formatter stays off** there on purpose:
enabling it is a 313-file, 22k-line diff that would bury every real change, and that is a separate
decision from the linter.

`packages/core` joined on 2026-08-27 (ISS-833) carrying 280 diagnostics that nothing counted, because
biome exits 0 on a warning and the blocking `core` lint step therefore passed straight over them.
**Registering it was a scope entry in `.forge/conformance.json` plus one `--update-baseline` run** —
no second script, no second baseline file. That is the contract to hold when the next class arrives.

### Level 1 is forbidden, and three rules say so rather than this paragraph

A check that runs, prints, and blocks nothing has no baseline to be held to, and every gate this
repo lost was at level 1 while documented as blocking. A check you cannot pass on the day you add it
is frozen at level 2 that same day — never merged at level 1 behind a comment promising cleanup.
`continue-on-error: true` is the same shape written in YAML.

**R8** fails on a CI step that cannot fail. **R9** fails on a biome rule left at a severity biome
exits 0 on that no baselined checker counts. **R10** fails on an axis that does not declare a
numeric level of at least 2 — including by omitting the key or quoting the digit. None of the three
is a number to read; each is a build that goes red.

### Adding a scope

```json
{ "cwd": "packages/<pkg>", "args": ["check", "src"],
  "drain": { "include": "^packages/<pkg>/src/", "exclude": "\\.test\\.tsx?$" } }
```

The scope directory must hold a `biome.json` — the linter-enabled guard reads it, and reads any
config it `extends`. A `biome.jsonc`, or a config resolved from a parent directory, exits 2 rather
than being assumed healthy.

`drain` is optional and a scope without it is freeze-only. `--update-baseline` then freezes the new
scope's debt and seeds its `original`; the `improves: down` ratchet accepts the widened baseline
because it compares totals per *area* and this one is new (see `lib/baseline-ratchet.mjs`).

### Drain — the half freezing does not do

Freezing stops growth; it does not reduce. The comment-debt baseline sat frozen for months at 3% drained,
which is the evidence that "not higher" and "lower when you edit it" are different rules. So for a
scope that declares `drain`: **touch a file it matches and its count must come back strictly
lower.** Equal fails. A file already at 0 stays at 0, a new file must be 0, and a rename carries its
debt through unpaid — the baseline is path-keyed, so charging a move would fire on every rename, and
a rule that fires on renames is a rule someone switches off.

Pay it by removing one diagnostic: restructure so the compiler narrows, or write
`// biome-ignore <rule>: <the invariant>`, which forces the reason into the source next to the code
it justifies. **Never `biome check --write` these rules** — it rewrites `a!.b` to `a?.b`, turning
"throw when the invariant is violated" into "silently evaluate to undefined".

Drain needs a branch delta. On a push straight to `main` the merge-base *is* HEAD, so drain is
skipped, freeze still runs, and the skip is **printed** — an unprinted skip reads identically to a
pass, which is how the prose gate once ran over zero files while printing success.

### Numbers, modes, exit codes

Every run prints, per scope, `current / original (N% drained)`. `original` is written once and
`--update-baseline` may only add a missing key: a denominator that gets recomputed makes each
percentage relative to the last re-freeze, so it can never fall and "trending to 0" stays exactly as
unfalsifiable as it was before anyone printed it. web-v2's `226` is its measured freeze figure from
2026-08-23, seeded by hand because the field did not exist yet; core's `280` was measured the day it
was registered.

Exit `0` clean · `1` a file gained a violation or skipped its payment · `2` could not run. Three
guards produce that last one, because a scope legitimately drained to zero and a scope nobody is
linting report identical numbers:

- **the baseline disagrees with the measurement** — a scope whose baseline freezes debt and which now
  measures **zero** exits 2, whatever config line did it, because this parses no config. Three review
  rounds each found another way to empty the input while biome still exits 0 — top-level
  `linter.enabled`, the same switch behind `extends`, then a single `overrides` block needing no second
  file at all — and enumeration lost every round. Draining a scope to zero is a real achievement and
  stays recordable, but never silently: `--update-baseline --accept-emptied-scope=<scope>` writes it,
  and the bare re-freeze refuses.

  **It catches a scope emptied entirely, not one emptied in part, and that gap is open.** Measured
  2026-08-27: an `overrides` block scoped to `src/features/issues/**` leaves web-v2 at 186 diagnostics
  over a full 459 scanned files, so no guard here fires and the next `--update-baseline` drops 9 files
  and 24 frozen diagnostics at exit 0 — accepted by `improves: down`, which only faults on a rise.
  Closing it needs a per-file "was this linted" signal biome's JSON reporter does not expose, and
  refusing `overrides` outright would false-fail the legitimate don't-lint-generated-code block. A test
  in `lib/lint-budget.test.mjs` pins it as declared rather than left to be rediscovered.
- **files scanned** — biome's own `summary` says how many files it looked at, and zero means the scope
  matched nothing. A narrowed `files.includes` lands here.
- **the linter is on** — the scope's resolved config, following `extends` to the end of the chain, must
  not disable the linter. An `extends` this checker cannot resolve from the filesystem (biome's package
  form, say) is itself an error, never a skip.

The last two are now a **second opinion that names the cause**: they fire before biome runs and say
which config line is wrong, where the first says only that the numbers stopped adding up. Keep all
three — a guard that explains a failure is worth having even once another guard would have caught it.

Modes: `--all` (CI, in the always-on `conformance` job; also `pnpm --filter web-v2 lint`) ·
`--staged` (**freeze-only** — the payment is due against the branch, not a half-staged tree) ·
`--update-baseline` (`--accept-emptied-scope` to confirm a scope really did drain to zero).
`--staged` exists for a pre-commit hook but **no hook runs it today**: `.githooks/pre-commit` runs
`check-source-language` and `check-test-signal` and nothing else. The gate is the `conformance` job.

## check-lockfile-transport.mjs — no dependency that only SSH can fetch

Not a gate and not an axis: it adds no job to `ci-passed` and nothing in `.forge/conformance.json`
names it. It is the one checker that runs **before** `pnpm install`, from
`.github/actions/setup-workspace`, because the thing it refuses is the thing that kills the install.

On 2026-09-14 a Dependabot pull request regenerated `pnpm-lock.yaml` and rewrote `forge-plugin`'s
resolution from `https://codeload.github.com/SidCorp-co/forge-plugin/tar.gz/<sha>` to
`git+https://git@github.com:SidCorp-co/forge-plugin.git#<sha>`. pnpm's git fetcher then ran
`git clone git@github.com:…`, which needs an SSH key no workflow here holds and which a
Dependabot-triggered workflow — denied every repository secret — could not be given. All six jobs
that reach the install through the composite died there with exit 128 before running a line of
their own work, `ci-passed` blocked the merge, and four dependency updates sat unmergeable for two
days because six unexplained reds read as a broken lockfile (ISS-1045).

pnpm is not the party that reaches for SSH: measured under 9.15.0 and 12.4.2, with SSH disabled,
the `github:owner/repo#sha` shorthand, a plain codeload tarball URL and a `git+https://` URL all
resolve to the same codeload tarball. The shorthand is gone from `packages/core/package.json` for
that reason — a URL is a string a second resolver cannot reinterpret, and the exact-commit pin now
lives in that URL's last path segment. **Bumping the pin means editing the sha at the end of the
URL**, not looking for a shorthand that is no longer there.

The rule is repository-wide rather than scoped to `forge-plugin`, and the price is stated rather
than discovered: CI here is never given an SSH key, so a dependency only SSH can fetch is one no job
here can install, and adding one has to be argued rather than merged. The refusal prints the https
form for a public repository pinned to a commit and does not claim every SSH dependency has a
credential-free equivalent — a genuinely private one does not.

`--ci-parity` asserts the placement, because the composite is `.github/workflows/ci.yml`'s blind
spot: the parity parser reads the workflow and never the action it calls, so deleting this step or
moving it below `pnpm install` would cost nothing and say nothing, while the `CHECKS` entry stayed
green on a clean lockfile. Both shapes now fail by name — measured by planting each one.

`scripts/lib/lockfile-transport.mjs` holds the classification, so the verdict has a test
(`lockfile-transport.test.mjs`, collected by `packages/core/vitest.config.ts`); the CLI reads the
tree and exits. Exit `0` clean · `1` an entry resolves over SSH · `2` no lockfile, or a lockfile
holding no `resolution:` at all — an empty scope is refused rather than forwarded as a pass.

It reads the text line by line rather than parsing YAML, because it runs before anything is
installed and so has no YAML library to reach for. Two shapes are read: an `ssh://` scheme
anywhere, and the scp-style `user@host:path` — for any username and any host, since the offender
that started this was `git@github.com:` but `deploy@gitlab:team/x.git` is the same clone. Three
things keep a lockfile's own ordinary rows out of it, and each one is a row that would otherwise
stop every install in every job:

- `//` after the colon is a URL scheme, so `forge-plugin@https://codeload…` — the entry this change
  ships — reads as the URL it is and not as a host called `https`.
- the path has to carry a `/`, or every `pkg@1.2.3:` key line would read as a host and a path.
- a comment goes before the forms run, or a comment quoting the old remote is an offender. Only a
  `#` that follows whitespace: a git resolution's `…/repo.git#<sha>` is a fragment, not a comment.

A bracketed IPv6 literal is read as a host, since its own colons need their own branch; the brackets
admit dots for the embedded-IPv4 form `[::ffff:192.0.2.1]`.

Those three narrowings cost the general form two shapes — `@host:1234/path`, which it reads as a
port, and `host:repo.git` with no slash in the path at all. Both are read by a third form scoped to
a `repo:` field, which needs neither narrowing: pnpm writes that field for a `type: git` resolution
and nothing else, so its value is always a bare remote and never a URL carrying userinfo. The forms
together report both, and still leave `https://user@host:8080/path/pkg.tgz` alone.

Both real lockfiles this was measured against agree: 948 resolutions on `main` clean, and the four
offending lines on the Dependabot pull request that caused this named by package.

## check-branch-name.sh

## check-release-record.mjs — the record of what shipped may not lose entries

`CHANGELOG.md` is the external record of what shipped, and until 2026-08-28 nothing owned it.
Commit `3df9a8e9` removed **1,034 lines, added 0** — the whole `[Unreleased]` block, every released
version section and the style header — inside a commit about closing 94 dangling docs pointers whose
message never named the file. Twelve gates ran on it and every one passed. The in-app What's New
feed parses this file (`packages/web-v2/src/lib/changelog.ts`) and renders an empty list when it
finds no `## [` heading, so it went blank for every signed-in user without throwing.

Two rules:

| | Fails when |
|---|---|
| `structure` | the file carries no `## [Unreleased]` heading — the What's New feed, the release step, the release cutter, the batch release plan and the release-notes schema all key on it |
| `no-silent-loss` | an entry present at the base revision is absent at HEAD and nothing declares the removal |

Entries are compared as a **set of whitespace-normalised bullet texts, position-independent**. That
is what lets `forge-cut-release` promote `## [Unreleased]` to `## [X.Y.Z]` and open a fresh one — a
release cut moves every entry under a new heading without losing one, and a positional comparison
would turn the next release red. Normalising whitespace is what stops a hard-wrap reflow reading as
30 deletions. Nothing further is normalised: case and punctuation are how you tell a reword from the
same entry.

Base revision comes from `baseRev()` in `lib/baseline-ratchet.mjs` — merge-base against `origin/main`
with the `HEAD~1` fallback, because a commit pushed straight to `main` has `origin/main == HEAD` and
a rule whose base can equal its subject passes everything. **No base revision is exit 2**, which is
why `lang-check` carries `fetch-depth: 0`.

### Removing an entry is legal, and it is declared

`.forge/changelog-amnesty.json` holds one `{entry, reason}` per removal, the entry verbatim and the
reason non-empty. That file is the ledger of every edit made to an already-published record: a
correction is fine, a correction nobody can see is not. It is not a bulk baseline and there is no
`--update-baseline` — a public record is edited one line at a time or not at all.

```bash
node scripts/check-release-record.mjs      # 0 the record holds · 1 it was broken · 2 could not run
```

The verdict half is in `lib/release-record.mjs` so it can be tested without a git tree; the CLI
reads git and exits.

## check-source-language.mjs — English-only source policy

Fails if any `.ts`/`.tsx`/`.md` file under `packages/web-v2/src/` or `packages/core/src/` contains non-allowlisted diacritics. See ISS-65 for context — the project is English-only across UI strings, identifiers, comments, docs, and tests, after ISS-43 leaked Vietnamese copy onto `main`.

### Modes

- `--staged` (default): scans STAGED content of files in `git diff --cached --diff-filter=ACM`. Used by `.githooks/pre-commit`.
- `--all`: walks the working tree across all three `src/` trees. Used by CI (`.github/workflows/ci.yml` `lang-check` job).

Exit codes: `0` clean, `1` violations found, `2` invalid invocation.

### Allowlist (per-line, evaluated in order)

1. **Brand-name literals** — small inline allowlist of foreign-glyph proper nouns (`Pokémon`, `café`, `naïve`, `résumé`, `cliché`, `façade`, `jalapeño`). If every diacritic on the line is part of an allowlisted brand, the line passes.
2. **Language picker entries** — line containing both `value: '<lang-code>'` and a `label:` token. Pattern: `{ value: 'vi', label: 'Tiếng Việt' }` legitimately needs the native script as the label value.
3. **`i18n-allow:` directive** — line ends with `// i18n-allow: <reason>` (or the `/*` / `<!--` variants). Same-line scope only; reason text is required.

### Bypass

`SKIP_LANG_CHECK=1 git commit ...` skips the pre-commit hook locally. CI cannot be bypassed — translate the offending strings or add an `i18n-allow:` directive with a reason.

## check-test-signal.mjs — low-signal test guard

Flags a test FILE that is mostly
declaration-shape assertions (`.columnType` / `.notNull` / `.hasDefault` / `.primary` /
`.isUnique` / `.dataType`) — assertions that restate what the declaration already says and
so can only fail on an intended change. FK `.onDelete` is deliberately not flagged.
Baseline-frozen in `.forge/test-signal-baseline.json`, same contract as the other frozen
baselines. Wired into the commit path.

The freeze comparison, the registry read, the baseline I/O and the staged-file collection are
`lib/debt-ratchet.mjs`, shared with the two biome budgets; what lives in this script is the
analyzer — which files to read and what to count in them. Thresholds and regexes are
`checkers.test-signal` in `.forge/conformance.json`, and deleting that block degrades to the
built-in defaults rather than to an empty scope.

## lib/debt-ratchet.mjs — the ratchet the three baselined checkers share

`check-test-signal`, `check-lint-budget` and `check-size-budget` all freeze `{path: {metric: n}}`
and fail when a metric rises, and each carried its own copy of that until ISS-848. The copies did
not agree, which is the point: `check-size-budget`'s own guard named `check-lint-budget` as the
version it must not drift from with nothing enforcing it, while `check-test-signal` fell back to
built-in defaults on an absent registry and read a failed `git diff --cached` as an empty stage —
a hook reporting clean because git broke.

What is shared is `freezeFaults` (a metric absent from the baseline reads as 0, so a new offender
fails), `readManifest` / `scopeConfig` / `tunedConfig`, `loadBaseline` / `writeBaseline`
(`null` for unreadable, `{}` for absent — a caller must be able to refuse rather than report
clean), `parseMode`, `stagedFiles` and `sortDeep`. What is not shared is the analyzer: biome for
the two budgets, regex scoring for test-signal, and `drain` stays in `lib/lint-budget.mjs` because
only a biome scope declares one.

`scopeConfig` refuses an absent manifest and `tunedConfig` degrades to defaults, which is not an
inconsistency: a scope list has no meaningful default, so inventing one measures directories the
manifest never declared, while `.forge/conformance.json`'s own `$comment` promises that deleting a
threshold block degrades to built-in behaviour. Both are pinned in `lib/debt-ratchet.test.mjs`.

`scripts/**/*.test.mjs` is collected by `packages/core/vitest.config.ts` and by nothing else, so
these run under the `core` job — which `ci.yml`'s `changes` filter triggers on `scripts` as well as
on `packages/core`. Locally they need `turbo.json`'s `test.inputs`: without
`$TURBO_ROOT$/scripts/**` a scripts-only change is outside `packages/core`, so `pnpm test` replays
a cached log and reports green over tests it never ran. Measured 2026-08-30 on the same touched
tree: cache HIT without that input, cache MISS with it.

## check-flow-coverage.mjs — every declared flow step must be walked

The join between the knowledge axis and the behaviour axis. A `cm:flow` annotation says *"this line
is step 4 of the dispatch flow"*; a v8 coverage report says which lines a test executed. A step named in the map
and executed by nothing is a step the next editor believes is defended.

It is measured, never declared — a `// covers dispatch/tick` comment in a test file would be exactly
the claim-instead-of-measurement that `conformance-status.mjs` exists to catch.

**What the evidence is, exactly.** `f` — istanbul's per-function invocation count. A step counts
as reached when the authoritative suite *entered* the function the annotation sits on, whatever
that call then did. It is NOT proof the flow ran through the step, and the report says so in those
words rather than calling it end-to-end (ISS-955: the summary used to read `N settled end-to-end`
and each row `e2e`, which readers took for "the flow ran"). Marks are `fn:e2e` / `fn:unit` / `--`.

The stronger reading — whether the annotated *statement* itself executed (`s`) — is measured on
every run and printed as an advisory count, because moving the gate onto it re-opens every settled
step at once and that is a decision about the gate. **Measured 2026-09-07 on a green 129-file
integration suite: 0 of 7 reached steps fail the statement rule.** So the level is not what was
wrong; `release/deploy`, the step that motivated ISS-955, has `fn=3 stmt=3` — the statement just
below its annotation is the early return, which runs. Statement-level evidence would have caught
nothing here.

**Authoritative vs not.** A step reached only by unit tests is printed as `fn:unit` and does **not**
count. With 974 `vi.mock` calls in `packages/core`, a unit test can execute a step's function with
every neighbour stubbed out — that proves the function runs, not that the flow connects. Only
sources marked `authoritative` in `.forge/conformance.json` (today: the integration suite) settle a
step.

The step list and the step **count** both come from one `git grep -n -I -- cm:flow` over the
checkout (`check-flow-coverage.mjs:collectSteps`). There is no second source, and so no
disagreement to detect — what `.forge/conformance.json` declares for a flow is a name and a
description, never a count. This paragraph claimed the count came from `cm flow <name>` and that a
disagreement between the two exits `2`, which described a cross-check the file does not perform.
Deleting the last annotation of a declared flow, or declaring a flow nobody annotated, does exit
`2` — never `0`.

```bash
pnpm --filter @forge/core test:integration:coverage   # produces the authoritative report
pnpm --filter @forge/core test:coverage               # optional, adds the UNIT column
node scripts/check-flow-coverage.mjs --all
```

`--require-sources` (CI) turns a missing report from a skip into a failure. `pnpm verify` skips this
check locally when no report is on disk; that skip is honest only because `core-integration` runs it
with `--require-sources`, and `--ci-parity` proves that step exists.

Uncovered steps freeze into `.forge/flow-coverage-baseline.json` via `--update-baseline`, so
declaring a flow is never punished — the debt just shows up in the diff. Today the baseline is empty.

## conformance-audit.mjs — the only check whose subject is the setup

`conformance-status.mjs` asks whether each axis does what it claims. This asks whether the setup
*around* them still has the shape `.forge/conformance.json`'s `profile` claims. Without it the
protocol is content-free: a repo can gate nothing, declare a profile, and be perfectly conformant.

R7 is the only rule here that runs anything, and it has to. The others read the setup off disk;
whether `archmap check` can resolve the graph it covers is only knowable by asking it. Ceiling:
`checkers.archmap.maxUnresolvableEdges`. It exists because `.forge/archmap/` is vendored and
`archmap install --force` re-vendors it from an upstream checkout — dropping this repo's `--ts-config`
support would take the count from 171 straight back to 998, silently, while every contract kept
printing `0 violations`.

| | Rule | Broken here on |
|---|---|---|
| R1 | an entrypoint exists | the repo had 6 checkers and no command for months |
| R2 | every check proves it scanned something | `core typecheck` and `conformance levels`, 2026-08-14 |
| R3 | every declared baseline, `alsoBaseline` included, has a direction | all four until `improves` was added; then 3 of 6 again, because the loop read only `spec.baseline` |
| R4 | every `ci-passed` needs-job is asserted by it | `archmap`, measured 2026-08-13 |
| R5 | both meta-checks present | — |
| R6 | no blocking level without CI to block with | — |
| R7 | the relations gate can resolve the graph it claims to cover | `archmap check` dropped 841 of 997 edges, 2026-08-23 |
| R8 | no CI step runs where it cannot fail | the desktop Rust gate, `continue-on-error: true` for months behind a comment promising cleanup |
| R9 | every **declared** severity biome exits 0 on (`warn`, `info`, `on`) is counted by a baselined checker — it reads the configs, so a rule left non-blocking by preset default is out of its reach | `packages/core`'s 280 `warn` diagnostics, invisible to R1–R7 because all seven judge a *declared* axis |
| R10 | every declared axis declares a numeric level of at least 2 | R1–R9 all skip an axis that is not level 2, and `hardened` needs only 4 of 5 — so an axis could declare 1, omit the key, or quote the digit, and pass the audit |

Profiles bound **shape**, never tool choice — `baseline` (one axis measures) · `standard` (two axes
block, both meta-checks) · `hardened` (every declared axis blocks, every needs-job asserted). "Two
axes blocking" ports to any stack; "must run biome" does not.

```bash
node scripts/conformance-audit.mjs      # 0 meets the claim · 1 does not · 2 cannot audit
```

Exit `2` on an unreadable manifest, an unknown profile name, or a manifest with no axis at all.
With no `profile` declared it reports the highest one the repo would meet and exits on the rules
alone.

It audits shape, not worth: a repo can pass all ten with an axis measuring something pointless. That
is deliberate — choosing what to measure is the repo's call, and a tool that ruled on it would start
dictating stacks.

## upload-image.sh — attach images from a runner

Uploads screenshots/images to a Forge issue or comment over REST. Exists because the MCP
runner and CI hold a PAT or device token but **no user JWT**, which the browser upload path
assumes.

```bash
upload-image.sh --issue   <issueId>   <file> [<file>...]
upload-image.sh --comment <commentId> <file> [<file>...]
```

Requires `FORGE_API_URL` plus a token in the environment — see the script's own header for
the exact variable names.
