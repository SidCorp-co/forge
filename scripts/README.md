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
a sibling that stopped blocking, which is the whole failure mode here. `form` is gated four times
(biome for `core`'s rules · `check-size-budget` for the length baseline biome cannot hold ·
`check-lint-budget` for `web-v2` · a bare `biome check scripts` for the checkers themselves),
`behaviour` three times (reachability · signal · flow coverage) and `knowledge` three (couplings ·
the autonomous status standard · honest costs).

**`record` is the axis that was missing.** The other five each own a property of the code, and on
2026-08-28 commit `3df9a8e9` removed 1,034 lines from `CHANGELOG.md` inside a commit about dangling
docs pointers whose message never named the file. Every gate above ran on that change and every one
passed, because the external record of what shipped belonged to none of them.

| Axis | Gate (CI job) | Owns | Must not touch |
|---|---|---|---|
| format + lint | `biome check` — `core` | whitespace, import order, recommended rules | comment content |
| size | `check-size-budget` — `conformance` | file & function length, frozen per file | which rules exist — biome declares them |
| lint debt | `check-lint-budget` — `web` | per (file, rule) biome violations in `web-v2`, frozen | which rules exist — `packages/web-v2/biome.json` declares them |
| checkers | `biome check scripts` — `conformance` | the files in `scripts/` that implement every other gate | anything under `packages/` |
| knowledge | `cm verify` — `codemap` | `cm:` couplings, prose discipline, module headers | anything a tool can derive |
| transitions | `check-autonomous-transitions` — `codemap` | that every bundled skill writes the kernel statuses `AUTONOMOUS_DRIVER_STATUSES` declares, never a render label | what an agent wrote at runtime — that lives in `activity_log` |
| costs | `check-honest-costs` — `lang-check` | whether `docs/VISION.md` and every `docs/proposals/*.md` price what adopting them costs | whether the price stated is honest — that is review's |
| relations | `archmap check` — `archmap` | which module may depend on which | how a file is written |
| reachability | `check-test-reachability` — `conformance` | whether every tracked test file is collected, and whether a skipped suite says why | what a test asserts once it runs |
| behaviour | `check-test-signal` — `lang-check` | whether a test asserts behaviour or restates a declaration | how many tests exist, coverage % |
| flows | `check-flow-coverage` — `core-integration` | whether every declared `cm:flow` step is executed end-to-end | which flows exist — codemap declares them |
| language | `check-source-language` — `lang-check` | English-only source policy | everything else |
| record | `check-release-record` — `lang-check` | whether `CHANGELOG.md` keeps the heading its five readers parse for, and whether a published entry can leave without a declared reason | whether an entry is TRUE, or whether a change deserved one — that is review's |

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

codemap says *which line is step 4 of the dispatch flow*; the integration suite's v8 report says
*which lines ran*. A step named in the map and executed by nothing is a step the next editor
believes is defended. **A step reached only by unit tests does not count** — with 974 `vi.mock`
calls in `packages/core`, a unit test can run a step's function with every neighbour stubbed, which
proves the function runs, not that the flow connects. Nothing is self-reported: a
`// covers dispatch/tick` comment in a test file would be the claim-instead-of-measurement the
manifest exists to catch.

### Why lint debt and size are their own rows

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
- **No comment rules outside codemap.** A density or run-length rule contradicts it outright: the
  19-line `/** */` block on `failReconcileRunIfNoVerdictRecorded` is documentation codemap exempts
  by form, and 19 comment lines to a counter.
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
manifest, a scope matching no files). Never read `2` as a pass — the same 1-vs-2 split `cm verify`
uses.

`.arch.json` declares `tsConfig: .arch-tsconfig.json`, and that line is load-bearing:
dependency-cruiser runs with `--no-config`, so without it nothing resolves through a tsconfig
`paths` alias — and an unresolvable edge is **dropped, not reported**. Measured 2026-08-23: 841 of
997 unresolvable edges were `web-v2`'s `@/*`, i.e. effectively that whole package's graph, while
three contracts over it sat `locked` and passed on nothing. With the map: 5,206 edges resolved, 170
unresolvable of 5,376 possible (3.2%) — all of them node_modules subpath exports, which belong to no
module. Audit rule R7 holds the ceiling, because `.forge/archmap/` is vendored and a re-vendor could
drop the support without a single test going red.

### Vendored checkers

**`.forge/` is committed, all of it.** Both checkers are vendored there (`.forge/codemap/`,
`.forge/archmap/`) and the CI jobs run those copies, so a contributor without a global install and
the gate are held to the same reviewed version — bump with `cm install --upgrade` / `archmap install
--force` and commit the result. `.forge/.gitignore` is the only place an exception may be declared,
and it carries the reason; a blanket `.forge/` in `.git/info/exclude` is a **local** rule teammates
never see, and it is why `orientation.md` went uncommitted for months.

Both vendored shims must stay mode `100755` — `git ls-files -s .forge/*/[ac]*` to check. A shim
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
4. **Advisory** — `cm impact` on every file changed against `origin/main`, including untracked ones,
   printing the guards / edges / flows you should read. This is the pull-side stand-in for the
   PreToolUse hook, and it works with no plugin installed.

### Modes

- (none) — full run
- `--ci-parity` — only the parity proof; cheap, zero-dep, no install needed
- `--no-advisory` — skip the `cm impact` pass

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

## check-lint-budget.mjs — biome debt in web-v2, frozen per (file, rule)

`packages/web-v2/biome.json` owns the rules; this owns only the baseline biome lacks — the same
split as `check-size-budget.mjs`, one package over.

web-v2 had no biome config at all until 2026-08-23. Measured the day it got one: **748 diagnostics —
409 formatter, 185 import order, 151 real lint errors.** `error` meant 151 red builds, `warn` meant
nothing held, so 226 violations across 101 files are frozen in `.forge/lint-baseline.json`. A file
already carrying debt may keep it and may lose it; it may not gain any.

Frozen per (file, rule) rather than per line, so moving or reflowing code inside a file is not a
violation.

The **formatter is off** in that config on purpose. Enabling it is a 313-file, 22k-line diff that
would bury every real change under it, and it is a separate decision from the linter — which is why
the two were separated rather than shipped together.

Exit `0` clean · `1` a file gained a violation · `2` could not run. That last one includes the case
biome reports **zero** diagnostics: web-v2 carries debt at rest, so an empty report means the scope
matched nothing or the config stopped loading, and reporting clean there is the fail-open shape every
other checker exits 2 on.

Modes: `--all` (CI, via `pnpm --filter web-v2 lint`) · `--staged` (pre-commit) · `--update-baseline`.

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

The test-side counterpart to codemap's comment rule: flags a test FILE that is mostly
declaration-shape assertions (`.columnType` / `.notNull` / `.hasDefault` / `.primary` /
`.isUnique` / `.dataType`) — assertions that restate what the declaration already says and
so can only fail on an intended change. FK `.onDelete` is deliberately not flagged.
Baseline-frozen in `.forge/test-signal-baseline.json`, same contract as the codemap
baseline. Wired into the commit path.

## check-flow-coverage.mjs — every declared flow step must be walked

The join between the knowledge axis and the behaviour axis. codemap says *"this line is step 4 of
the dispatch flow"*; a v8 coverage report says which lines a test executed. A step named in the map
and executed by nothing is a step the next editor believes is defended.

It is measured, never declared — a `// covers dispatch/tick` comment in a test file would be exactly
the claim-instead-of-measurement that `conformance-status.mjs` exists to catch.

**Authoritative vs not.** A step reached only by unit tests is printed as `UNIT` and does **not**
count. With 974 `vi.mock` calls in `packages/core`, a unit test can execute a step's function with
every neighbour stubbed out — that proves the function runs, not that the flow connects. Only
sources marked `authoritative` in `.forge/conformance.json` (today: the integration suite) settle a
step.

The step list comes from a grep, but the step **count** comes from `cm flow <name>`; a disagreement
exits `2`. Deleting the last annotation of a declared flow, or declaring a flow nobody annotated,
also exits `2` — never `0`.

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
| R3 | every level-2 axis has a baseline with a direction | all four, until `improves` was added |
| R4 | every `ci-passed` needs-job is asserted by it | `archmap`, measured 2026-08-13 |
| R5 | both meta-checks present | — |
| R6 | no blocking level without CI to block with | — |
| R7 | the relations gate can resolve the graph it claims to cover | `archmap check` dropped 841 of 997 edges, 2026-08-23 |

Profiles bound **shape**, never tool choice — `baseline` (one axis measures) · `standard` (two axes
block, both meta-checks) · `hardened` (every declared axis blocks, every needs-job asserted). "Two
axes blocking" ports to any stack; "must run biome" does not.

```bash
node scripts/conformance-audit.mjs      # 0 meets the claim · 1 does not · 2 cannot audit
```

Exit `2` on an unreadable manifest, an unknown profile name, or a manifest with no axis at all.
With no `profile` declared it reports the highest one the repo would meet and exits on the rules
alone.

It audits shape, not worth: a repo can pass all six with an axis measuring something pointless. That
is deliberate — choosing what to measure is the repo's call, and a tool that ruled on it would start
dictating stacks.

## check-lockstep.mjs — a declared pair where only one half moved

The second join. `cm` knows which files carry `cm:edge lockstep` — *"these two must change
together"*. `git` knows which files a change touched. Neither can know that one half moved and the
other did not, and neither should: `cm` has no business knowing your merge-base, and `git` has never
heard of an edge.

Today: 49 lockstep edges across 66 files. The three orphan-hygiene defences are the worked example —
change `runs-cascade.ts` alone, tests stay green, merge, and an orphan job wedges a runner slot.

**It ships advisory, and that is a design decision, not a stepping stone.** A lockstep edge means
*"the other side likely needs this too"*, not *"every keystroke here needs a matching one there"* — a
rename or a comment edit legitimately moves one side alone. Blocking on that teaches people to route
around the checker, which costs more than the check earns. `pnpm verify` prints the drifting pairs
after the summary table and does **not** let them change its exit code.

```bash
node scripts/check-lockstep.mjs                  # pairs drifting vs origin/main, exit 0
node scripts/check-lockstep.mjs --staged         # same, against the index
node scripts/check-lockstep.mjs --all            # every declared pair
node scripts/check-lockstep.mjs --strict         # exit 1 when a pair drifted
```

Exit `2` when the graph cannot be read, when it carries **no** lockstep edge (the checker's whole
scope is empty — that is not a pass), or when the changed set cannot be computed.

It is not an axis and is deliberately absent from `.forge/conformance.json`. Attaching a level-1
checker to the level-2 `knowledge` axis would drag that axis down to 1, because an axis measures at
its weakest gate — the manifest telling the truth here is the system working, not a gap.

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
