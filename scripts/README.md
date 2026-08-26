# scripts/

Project-level utilities. Each has a comment header explaining its contract, and each depends on
nothing outside `node:*` and `scripts/lib/` — the shared comparators that decide whether a frozen
baseline may move, which are unit-tested rather than verified by hand.

**No check may run at level 1** — running, printing, blocking nothing, with no baseline. A check you
cannot pass on the day you add it gets frozen at level 2 that same day; `continue-on-error: true` is
the same thing written in YAML. Three audit rules below make that a build rather than a convention:
R8 on a CI step that cannot fail, R9 on a lint rule at a severity biome exits 0 on (`warn`, `info`,
or `on`, which means the rule's default), R10 on an axis the manifest does not declare at level 2 or
above — including by omitting the key or quoting the digit.

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

## check-lint-budget.mjs — every biome diagnostic that is not a length rule, frozen per (file, rule)

Each package's `biome.json` owns the rules; this owns only the baseline biome lacks — the same split
as `check-size-budget.mjs`, which keeps the two length rules because it freezes them by line count.

It counts **every** diagnostic biome emits in a scope except the two length rules
`check-size-budget.mjs` owns — error severity included, and today 147 of web-v2's 210 frozen
diagnostics are errors. Severity decides only whether biome itself would have failed the build:
`error` meant red builds nobody could clear, and a severity biome exits 0 on (`warn`, `info`, or a
rule left at its default by `on`) held nothing. So both packages' debt is frozen per (file, rule) in
`.forge/lint-baseline.json` and only growth fails. Frozen per rule rather than per line, so moving or reflowing code inside a file is not a violation. Today: **486 violations
across 175 files** — web-v2 210 of an original 226 (95 files), core 276 of 280 (80 files, of which
53 diagnostics across 32 files are drainable).

`web-v2` had no biome config at all until 2026-08-23 — 748 diagnostics on the day it got one, 409
formatter, 185 import order, 151 real lint errors. The **formatter stays off** there on purpose:
enabling it is a 313-file, 22k-line diff that would bury every real change, and that is a separate
decision from the linter.

`packages/core` joined on 2026-08-27 (ISS-833) carrying 280 diagnostics that nothing counted, because
biome exits 0 on a warning and the blocking `core` lint step therefore passed straight over them.
**Registering it was a scope entry in `.forge/conformance.json` plus one `--update-baseline` run** —
no second script, no second baseline file. That is the contract to hold when the next class arrives.

### Adding a scope

```json
{ "cwd": "packages/<pkg>", "args": ["check", "src"],
  "drain": { "include": "^packages/<pkg>/src/", "exclude": "\\.test\\.tsx?$" } }
```

`drain` is optional and a scope without it is freeze-only. `--update-baseline` then freezes the new
scope's debt and seeds its `original`; the `improves: down` ratchet accepts the widened baseline
because it compares totals per *area* and this one is new (see `lib/baseline-ratchet.mjs`).

### Drain — the half freezing does not do

Freezing stops growth; it does not reduce. The codemap baseline sat frozen for months at 3% drained,
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

Exit `0` clean · `1` a file gained a violation or skipped its payment · `2` could not run. That last
one includes biome reporting **zero** diagnostics: both scopes carry debt at rest, so an empty report
means the scope matched nothing or the config stopped loading, and reporting clean there is the
fail-open shape every other checker exits 2 on.

Modes: `--all` (CI, in the always-on `conformance` job; also `pnpm --filter web-v2 lint`) ·
`--staged` (pre-commit, **freeze-only** — the payment is due against the branch, not a half-staged
tree) · `--update-baseline`.

## check-branch-name.sh

Validates a branch name against the [Trunk-Based Development](../docs/guides/trunk-based-development.md) naming convention. Wired into `.githooks/pre-push`.

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
