# scripts/

Project-level utilities. Each script has a comment header explaining its contract. A checker whose verdict is worth testing keeps that half in `lib/` — the CLI spawns, reads the tree and exits, none of which a test can call.

## Every gate, six axes

Each gate sits in `ci-passed`'s `needs` **and** is named in its result loop. Both halves are
load-bearing: `ci-passed` runs `if: always()`, so a job listed in `needs` but absent from the loop
completes, is ignored, and cannot fail the gate. `archmap` was in exactly that state — measured
2026-08-13, documented as the relations gate the whole time it could not block anything.
`verify --ci-parity` now fails on the mismatch.

**Four jobs gate nothing, on purpose, since ISS-1370**: `core-integration`, `whole-tree`, `images`
and `runner-platforms` (the runner's macOS and Windows legs) run on every push to a gated branch and
nightly, never on a pull request, and sit outside `ci-passed`'s `needs`. A red there is fixed forward
by whichever run lands next. The owner ruled it for forge-dev while it is a beta with no production;
`.forge/conformance.json` `$postMerge` names the four, what the move costs and what ends it, and
conformance-audit R12 fails on a job that is in no list or in two. **Three more gate no merge
either**: `whole-suite`, `suite-bisect` and `nightly-fanout` run only in a whole-suite run, declared
in `$wholeSuite` (ISS-471) — see *whole-suite.mjs* below. So the `selection` row
below measures after the merge, not before it. The runner's trade is narrower: its
compile and lint errors for all three targets still gate the pull request, because the ubuntu
`runner` job clippies `x86_64-pc-windows-gnu` and `x86_64-apple-darwin` too — the class of #816, an
unused import behind `cfg(windows)`. Only runtime differences — CRLF, path separators, temp-dir
symlinks, the class of #811 and #813 — wait for `runner-platforms` after the merge. The ending
condition is the same.

**The four run on a branch before it lands when somebody asks**:
`gh workflow run CI --ref <branch> -f base=<the branch it lands on>`. A dispatched run takes all four
— `core-integration`, `whole-tree`, `images` and both `runner-platforms` legs — with no path filter
deciding, as the nightly one does, and `ci-passed` needs what it needs on a pull
request. `base` is required and has no default, because every delta-scoped gate measures against it
and GitHub cannot know where a dispatched branch lands — the dispatch row of the merge-target table
below.

Every gate that drifted did so while documented and non-blocking — biome to 366 errors, `typecheck`
to 84, the two length rules to 143 — and each stopped drifting the day it was baselined and gated.

**An axis measures at its weakest gate.** Reporting the strongest would let one locked checker hide
a sibling that stopped blocking, which is the whole failure mode here. `form` is gated five times
(biome for `core`'s rules · biome for `web-v2`'s rules, the two length rules among them · a bare
`biome check scripts` for the checkers themselves ·
`check-provider-literals` for where an integration provider may be named and where core may call out · `check-integration-declarations`
for whether each provider declares the fields the generic paths read),
`behaviour` twice (reachability · signal) and `knowledge` six (honest
costs · the PAT permission surface · whether one question
in the source has more than one answer · whether a document's citations of this repo's own files
are still true · whether the published API and MCP contracts are what the code serves · whether
every pattern catalog entry names a reference, a test shape and a checklist that exist).

**`record` is the axis that was missing.** The other five each own a property of the code, and on
2026-08-28 commit `3df9a8e9` removed 1,034 lines from `CHANGELOG.md` inside a commit about dangling
docs pointers whose message never named the file. Every gate above ran on that change and every one
passed, because the external record of what shipped belonged to none of them.

| Axis | Gate (CI job) | Owns | Must not touch |
|---|---|---|---|
| format + lint | `biome check src` — `core` and `web` | whitespace, import order, recommended rules, every one at `error` with nothing frozen | comment content |
| size | `biome check src` — `core` and `web` | file & function length: both packages hold biome's two length rules at `error`, nothing frozen | anything else biome checks — that is the row above |
| checkers | `biome check scripts` — `conformance` | the files in `scripts/` that implement every other gate | anything under `packages/` |
| lazy init | `check-lazy-module-init` — `conformance` | whether a read of `env` or `db` runs when a core module is merely IMPORTED | what the value is once read, or whether a caller should be reading it at all |
| provider literals | `check-provider-literals` — `conformance` | whether a provider's name (`coolify`, `sentry`, …) is written outside the locations `.forge/conformance.json` allows WITH a reason: that provider's own directory, the registry, the schema and contracts vocabularies; and whether core imports a vendor SDK `egress.vendorSdks` lists outside `packages/core/src/integrations/`, beyond the exceptions `egress.exceptions` names with a reason (ADR 0006) | whether a name allowed there is USED correctly; and `agent`, which this repo also spells as an actor, an author and a principal — excluded by name, with its reason and its retirement condition printed on every run; and the global `fetch`, which is `check-module-shape`'s |
| declarations | `check-integration-declarations` — `conformance` | whether every provider in the live registry carries the capability, schema and agent-path fields the generic paths read — including a non-empty `justification` on a `direct-mcp` arm, since that arm puts a project's credential on a runner box | which archetype a provider SHOULD be — that is the declaration's author's, and review's |
| PAT surface | `check-pat-surface` — `conformance` | whether every route the running app serves under a project-reach permission reaches the PAT fence, `packages/core/src/credentials/pat-scope.ts:fencedProjectIds`, one route at a time: the routes come from `app.routes` under the contract generator's hermetic environment, each is matched to a registration the TypeScript checker finds from `packages/core/src/index.ts` (through `.route()` nesting and a router handed to a registering function), and it is fenced only when that registration's own handlers, or a middleware its router registered before it on a covering pattern, call the fence through calls the checker resolves to declarations in `packages/core/src`. Reachability is per FUNCTION: a module holding one fenced function lends nothing to the functions beside it, which is how ISS-28's planted route passed the file-level check this replaced. A served route no registration spells is refused, never skipped; a path in `PAT_UNGRANTABLE`, or on the gate's short EXEMPT list of routes that read no project's data, is not walked | whether a given fence is correct — a handler that reads the fence for one project and then serves another passes; a call through a value the checker cannot resolve reaches nothing, so that gap errs red, never green |
| status tuples | `check-status-tuples` — `lang-check` | whether one question has more than one answer: two declarations holding the same status tuple, or a status-literal array written inline where a named constant for that tuple already exists. Compares by VALUE, not by name, in either quote style, and reads the four vocabularies out of their machines (`packages/contracts/src/issue-machine.ts`, `packages/contracts/src/job-machine.ts`, `packages/contracts/src/session-machine.ts`, `packages/contracts/src/run-machine.ts`) rather than carrying a copy. It scans `packages/core/src`, `packages/contracts/src` and `packages/web-v2/src`: a browser file answering a question core already answers is the same defect as a core file doing it. A declaration reaches it by three routes — an array literal, a `new Set(...)` of one, and a `Record<…Status, boolean>`, whose `true` keys are a tuple written as a classification. A `status-tuple: differs` marker excuses a declaration only against a peer it NAMES, because a reason written about one neighbour is no excuse against a different one. And one NAME answers one question: a name holding two different tuples is refused whatever the markers say, because two answers under one name never collide by value — which is exactly how `packages/core/src/pipeline/runs-rollup.ts` held a three-member `LIVE_JOB_STATUSES` beside the four-member one with this gate green | whether a tuple's MEMBERSHIP is right; SQL string literals including `ARRAY[…]`, type unions, a tuple written as an object-literal value, which is a table row rather than a named question, and a `Record<…Status, T>` for any `T` but boolean, which is a lookup table rather than a yes/no question. In a test file it reads `.each` case lists ONLY: that list is the domain the test claims to cover, while every other tuple there is the assertion itself, which importing the constant would make vacuous. **Nor a copy that has already drifted**: two answers to one question whose members no longer match do not collide, so this catches a second declaration before it rots and never after; one declaration per vocabulary, its machine in `packages/contracts/src/machines.ts`, is what keeps a pair from forming |
| doc citations | `check-doc-citations` — `lang-check` | whether a document's citation of a file in this repo is still true: a path no tracked file carries and an anchor whose file does not hold that symbol each fail, a line-number citation fails because `CLAUDE.md` already forbids one, and a live citation whose target was changed after the document was comes back on the worklist without failing. Resolves in two scopes and no third — the document's own directory and its package — with a root-written path resolved exactly or not at all, so no namesake can stand in for a deleted file and no part of resolution reads whether the target is present. An excusal names the tokens it excuses | a document's PROSE, which no machine can check; a count or a number in a document; whether a symbol that still exists still means what the sentence says; `CHANGELOG.md` and `docs/proposals/`, each excluded with its reason in `.forge/conformance.json` |
| API contracts | `check-api-contracts` — `conformance` | whether `packages/core/contracts/forge-api.openapi.json` and `forge-mcp.tools.json` are byte for byte what the generator writes from the running app, naming each route (`METHOD /path`) or tool that was added, removed or changed and the JSON pointer where it differs; and whether every mounted route and served tool is describable at all — one the generator cannot describe is its refusal, never an omission | whether a route's contract is GOOD — a response schema, a missing validator, a description; and whether a change is breaking, which is the differ's (oasdiff, and a JSON Schema differ for the tools) |
| pattern catalog | `check-pattern-catalog` — `lang-check` | whether every page under `docs/patterns/` (REQ-36 BC-3, BC-4) names its change kind, the issue that introduced it, a `## Reference` of tracked files, a `## Test shape` naming a tracked reference test, and a numbered `## Review checklist`; whether the index links every page; whether every change kind `.forge/conformance.json` declares has a page; and whether `packages/contracts/src/pattern-catalog.ts`, the catalog core reads to tell a catalogued pattern from a new one, is what the pages say (`--write` regenerates it) | whether a reference is a GOOD one, or a checklist line the right one — that is the new-pattern reviewer's; module shape, which is `relations`' and which the core-module page points at rather than restates |
| costs | `check-honest-costs` — `lang-check` | whether `docs/VISION.md` and every `docs/proposals/*.md` price what adopting them costs; and whether every file directly under `docs/proposals/` opens with a `**Removed when:**` line naming at least one issue key, the issue whose landing change deletes the file (`docs/proposals/destination/` is exempt) | whether the price stated is honest, or whether the named issue really carries the condition — that is review's |
| relations | `archmap check` + `check-module-boundaries` + `check-module-shape` — `archmap` | which requirement or workflow step every core module, web-v2 feature and runner crate serves (`check-module-shape`'s trace); which module may depend on which: archmap's contracts, and pattern v2's context direction, kind direction, runtime cycles between modules, face-only access, adapter ports and read models' declared reads over `packages/core/src`, generated from `packages/core/src/modules.json`; and which module may write which table, and where a database call, a refusal and the global `fetch` may be written (`check-module-shape`) | how a file is formatted; a status written outside the kernel, which the database refuses (`forge_kernel_status_guard`) |
| reachability | `check-test-reachability` — `conformance` | whether every tracked test file is collected, and whether a skipped suite says why | what a test asserts once it runs |
| selection | `check-whole-tree-gates` — `whole-tree`, after the merge | whether a test whose input is the whole repository runs on every change: it runs every test carrying `@gate-input whole-tree` under the vitest config that collects it, refuses a declared file that ran no case or failed to load, and refuses an undeclared test that builds a path to the root and lists a directory | which jobs `changes` selects for everything else, and what a declared test asserts |
| behaviour | `check-test-signal` — `lang-check` | whether a test asserts behaviour or restates a declaration | how many tests exist, coverage % |
| language | `check-source-language` — `lang-check` | English-only source policy | everything else |
| record | `check-release-record` — `lang-check` | whether `CHANGELOG.md` keeps the heading its five readers parse for, whether a published entry can leave without a declared reason, and what an added or corrected entry may spend | whether an entry is TRUE, or whether a change deserved one — that is review's |

### Why `core` lint prints every diagnostic

`--max-diagnostics=none` is not verbosity, it is the difference between a gate that names its
failure and one that names a bystander. biome truncates at 20 by default and orders by path, not by
severity, so with 399 baselined warnings in `packages/core` the one ERROR that fails the build is
simply not printed. Measured 2026-08-31: a planted format error in `packages/core/src/ws/server.ts` produced
`Found 2 errors.` and **zero** mentions of that file, while the visible diagnostics all pointed at
a test file that was clean and untouched.

### Conformance levels

`.forge/conformance.json` declares each axis's level — `0` no checker · `1` measures, does not
block · `2` baseline the old, block the new · `3` zero violations. Today: form 3 · knowledge 3 ·
relations 2 · behaviour 3 · language 3 · record 3. `conformance-status.mjs` prints
them beside what it measured, so this line is a convenience and that command is the answer.

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

### Why a whole-tree test is selected by its own declaration

`changes` selects a job by the paths a pull request touched. That is right for a test of one
module and wrong for a guard that walks every file: #710 changed only documents, `core` was
skipped, `ci-passed` read the skip as a pass, and the guard the document broke left `main` red for
the next branch to find (ISS-1314). A path list in the workflow would repeat that one directory
later, so the declaration lives in the test and moves with it. The root-walk refusal is a backstop
on the declaration and never the selection; over-declaring costs seconds. It decides "reaches the
root" by what a test's run really lists, never by reading its source: `lib/whole-tree-guard.mjs`
watches the `node:fs` listing calls, spawns and workers of the test's process and of every Node
process it starts, and `lib/whole-tree-shell.mjs` reads each spawned program by its argv or shell
string, counting what it cannot evaluate — a substitution, a program, git subcommand or setting it
does not know — as the root. Three readings of the source by its spellings each passed one they had
not listed (ISS-1314). `import.meta.glob` is the one text read, in every tracked file, since vite
expands it before the test runs and accepts only literals. The guard's own files select `core`,
`core-integration` and `web`, the three jobs whose suites it runs in. A test reading one NAMED file
outside its package is not this checker's, and neither is what no observer inside the test sees —
native code, and a listing delegated to a process the test did not start. All three are recorded in
`docs/proposals/a-test-reading-a-named-file-outside-its-package-is-not-selected-by-it.md`.

### Why size is its own row

biome **declares** the two length rules (a file over 500 lines, a function over 150) but has no
baseline, so while debt existed the only choices were `warn` (nothing held) and `error` (every build
red). `packages/core` drained to zero first; `packages/web-v2` held them at `warn` over a frozen
per-file ratchet until its last offender was split, and now holds them at `error` too. Size is its
own row because it is the one biome rule this repo ever had to freeze; today it has no checker of
its own, and a new over-long function fails the package's `lint` like any other rule.

The `web-v2` formatter stays **off** on purpose: enabling it is a 313-file, 22k-line diff that would
bury every real change under it.

### Declared severity downgrades

`packages/core/biome.json`'s first `overrides` block is scoped to `**/*.test.ts` and
`**/tests/**`: `suspicious/noThenProperty` goes `off` for Drizzle's thenable query builder. It is a
downgrade of a rule the preset makes an error, so it belongs in this accounting rather than only in
the config — an undocumented severity downgrade is how an axis stops meaning what its row says.

### Do not add a rule to an axis another already owns

- **No ESLint on the LENGTH axis.** biome >= 2 covers `noExcessiveLinesPerFunction` and
  `noExcessiveLinesPerFile`. The only ESLint here is `eslint-module-shape/`, the type-aware
  module-shape rules, which hold no length or comment rule; two linters holding one axis means two
  configs drifting apart.
- **No comment rules in biome, or anywhere.** A density or run-length rule cannot tell
  documentation from noise on its own: a 19-line `/** */` block above a function can be
  documentation, and 19 comment lines to a counter are not.
  The comment-grammar gate removed in ISS-1029 flagged prose that was right more often than prose
  that was wrong, and a checker at that noise level teaches the reader to skip it. The
  comment-budget gate that followed it was removed by the owner on 2026-10-04 with the rest of
  codemap. Comment content is review's.
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

### check-module-boundaries

Pattern v2's import rules (ISS-184, ADR 0008). The rule set is generated from
`packages/core/src/modules.json` on every run, so a kind or a context is declared once and never
restated in a config file. Two dependency-cruiser cruises over `packages/core/src`, tests excluded:
one over every import for `context-direction`, `kind-direction`, `face-only` and `adapter-port`, and
one over the imports that evaluate at load (no type-only, no dynamic) for `runtime-cycle`.
dependency-cruiser keeps a single cycle per import, so filtering that cycle by type in one cruise
would hide a runtime cycle behind a found one through a type edge; the second cruise is what
prevents that.

`undeclared-read` (ISS-188) is the one rule that is not an import: every read model file is scanned
for the declared tables it SELECTs, a raw SQL `FROM` or `JOIN` naming one or a value import of one
from a schema file (`lib/module-shape.mjs:tableReads`), and each must be under the read model's
`reads` (or its own `projections`) in `modules.json`. Its keys are `<file> -> <table>`. A declared
read that no file of the read model SELECTs, and whose owner's read files it does not import, is a
<!-- doc-citation: unchecked `read.ts` `read/` — file-name patterns a module may use, not paths in this tree -->
declaration fault. A read model's import of an owner's read files (`read.ts`, `<x>-read.ts`,
`read/`) for a table it declares is exempt from `face-only` and `context-direction`
(`lib/module-boundaries.mjs:readFilePattern`).

Nothing is frozen: every rule is at zero, and no flag or file can admit a violation. Exit `1` on a
declaration fault or any violation, each printed as `<rule>: <importing file> -> <imported file>`;
exit `2` when it cannot run.

### check-module-shape

Pattern v2's declaration and semantic rules (ISS-196, ADR 0008). It first refuses a
`packages/core/src/modules.json` that contradicts itself (`lib/module-shape.mjs:parseDeclaration`)
or leaves a directory under `packages/core/src` with no kind, and a `global-fetch` allow entry or
a `table-writer` generic entry naming a file that no longer exists. Then it runs ESLint with
`eslint-module-shape/eslint.config.mjs` over `packages/core/src`, tests excluded, with type
information from `packages/core/tsconfig.json`:

- `table-writer`: an `insert`, `update` or `delete` on any value whose type is a Drizzle
  `PgDatabase` or `PgTransaction`, whose argument's type is a table (its SQL name read from the
  table type, so an alias or a variable holding the table is the table), and raw SQL in a `sql`
  template or `sql.raw` that writes a declared table, a `${table}` interpolation included — each
  outside the module `modules.json` names as the table's owner. A write whose table type does not
  carry its name (a `PgTable` parameter) is refused too, since its owner cannot be judged, except
  in a file the config's `generic` entries name with their `why`: the kernel's one status writer
  (`packages/core/src/lifecycle/transition.ts`), which writes whichever machine's table moves. A
  write to a concrete table there is still judged.
- `route-query`: a database call on a value of either type in a route file
  (`lib/module-shape.mjs:isRouteFile`).
- `refusal`: an `HTTPException` with a rule status, an `Error` subclass outside platform and
  adapter modules, a thrown `"<CODE>: …"`, a refusal-code list declared in core, and a
  `c.json(…, <rule status>)` body built by hand.
- `global-fetch`: a reference to the global `fetch` (scope analysis, so a local binding is not
  it) or `globalThis.fetch` outside an adapter module, beyond the config's `allow` entries, each of
  which must carry its `why`.

Inline `eslint-disable` comments are not read (`noInlineConfig`), so
`.forge/module-shape-suppressions.json`, ESLint's bulk-suppressions file keyed
`<file> -> <rule> -> count`, is the only amnesty. Exit `1` on a refused declaration, a violation
the file does not hold (a file whose count for a rule rose shows all of that rule's findings), an
entry whose count exceeds what occurs (a deleted file included), or a rule whose frozen total rose
over the base revision (`lib/baseline-ratchet.mjs:baseRevision`); exit `2` when it cannot run.
`--prune` drops entries that no longer occur; nothing here adds one, and a hand edit that raises a
rule's total is what the base-revision comparison refuses. `--markers <file>` writes every finding, frozen or not, as the
reconciliation Wrong markers (`lib/module-shape.mjs:markers`). A type-aware run over core takes
about 40 seconds.

**Requirement trace** (ISS-221, `lib/module-trace.mjs`). Before the lint it reads `serves` on every
unit `packages/core/src/modules.json` declares — `modules` (core), `web` (each directory under
`packages/web-v2/src/features`) and `runner` (each crate under `packages/runner/crates`) — against
`.forge/design-index.json`, the requirements and workflow steps of the Forge project that
`refresh-design-index.mjs` writes from the dev API (a `FORGE_TOKEN` run, never verify's).
`trace-empty`: an empty `serves`, or a web feature or crate directory with no entry; `trace-unknown`:
a reference to a requirement that is absent or dropped, a workflow, or a step the snapshot does not
hold; `trace-via`: `via:<unit>` naming a unit that serves nothing directly. A declared web feature or
crate with no directory is refused outright. Nothing is frozen: any untraced unit fails. Planted red before landing: an emptied `labels`, `REQ-999`, a step that does not exist,
`via:pm` (itself untraced), an emptied web feature and a new feature directory with no entry — each
named with its unit and rule, and the three modules that serve through `labels` named under
`trace-via`.

Each rule was seen going red on a planted violation before landing: an aliased table written
through a receiver named `handle`, `UPDATE ${issues} AS i SET`, `h.select()` in a `*-routes.ts`,
`new HTTPException(409)`, an `Error` subclass, a thrown code, a hand-built 422 body, a code list,
and `globalThis.fetch` and a bare `fetch` value, plus a stale and a deleted-file suppression.

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

   **What parity cannot reach: a check with no step in this tree.** CodeQL runs from GitHub's
   default setup, so there is no workflow file for the parser to read and nothing here can run it.
   Measured on PR #586 (ISS-1153): every job in `ci.yml` passed, `ci-passed` was green, and the PR
   was still held — by a high-severity CodeQL alert on a test helper that `pnpm verify` had no way
   to mention. Each post-merge job prints under its own heading, which says they run after the
   merge (ISS-1370), read off which jobs `ci-passed` needs: one line per job, naming its platforms
   and what each step is locally, so a job that runs a gated step on another platform is listed
   too. `pnpm verify` names
   CodeQL under a heading of its own, `Nor these, which ci-passed does not gate either`, kept apart from the commands CI does run because `ci-passed` gates those and
   does not gate this — and as a line rather than a command, since it is not runnable locally. What
   would stop the merge is requiring CodeQL at the merge gate in its own right — a branch-protection
   setting adding that check to the repository's required status checks, which no diff in this
   repository can do. It would NOT make
   `ci-passed` reflect CodeQL: `ci-passed` reads only its own `needs`, and a default-setup job is
   not in this workflow's graph. The two would sit side by side, and a green aggregate would still
   not mean the merge is clear.
2. **Fail-closed** — each checker must emit a file count that this script can read, and a count of
   zero exits `2`, not `0`. A checker whose scope matched nothing reports "clean"; forwarding that as
   a pass is the failure mode this guards.
3. **Report everything** — no early exit. One fix cycle instead of six.
4. **Bounded width** — the checks run at a concurrency of 6 rather than all at once, overridable
   with `VERIFY_CONCURRENCY`. Why 6 and not more was measured, and the measurement lives at the
   thing it decided: the rationale on `verify.mjs:runAll`.

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
| `skip` | did not run: not reproducible here, and the row names the ci.yml step that runs the same assertion | 0 | this checkout |

`skip` is the one mark that exits `0`, so it is the one an unrun gate can hide behind, and it is
fenced accordingly. A check may declare `skipIf` only alongside `coveredBy`, naming the ci.yml step
that runs the same assertion word for word; `assertEverySkipIsCovered` reads the workflow off disk
before any check spawns and exits `2` if the step is not there. The row then prints that step rather
than a generic sentence, so the reader is told what is standing in for the run.

That fence exists because the warrant was once only a comment. The runner's cargo gates carried a
`skipIf` matching a line the checker printed **exactly when there was a crate change and no cargo to
measure it** — so the one case worth catching was the one that went green. Measured 2026-09-18:
`pnpm verify` printed `skip` and exited `0` over six changed crate files, on the axis where every
platform defect of that week lived. `check-runner-gates.mjs` now exits `2` there, which is `n/a`;
a change touching no crate file still scopes to zero and exits `0` several lines earlier, so a
contributor with no Rust toolchain pays nothing for TypeScript work (ISS-1096).

`n/a` is not an amnesty. It exits `2` exactly as `FAIL` does, because an unrun gate is no evidence
and this script does not forward no-evidence as a pass — what changes is only the sentence a reader
gets. Prerequisites are declared per check as `needs:` and resolved against the **filesystem** by
`lib/prerequisite.mjs`, never against a tool's output text: a missing binary and a genuinely broken
import both print `Cannot find module`, and classifying by message would turn a real defect into
"could not run", which is this bug inverted and strictly worse because it goes green.

Preflight happens **before** the spawn. A checker run without its tool produces a sentence about its
own subject — `biome output in packages/core was not JSON`, `archmap: scope matched no files` — and
once that sentence exists nothing downstream can unsay it.

**A prerequisite is only as good as the thing it resolves.** Measured 2026-09-18: `deps` resolves
three `node_modules` directories, all three were present, and `archmap` still printed `scope matched
no files (.)` and exited 2 in 0.117s.
<!-- doc-citation: unchecked `bin/dependency-cruise.mjs` `bin/dependency-cruiser.mjs` — both are inside the dependency-cruiser package, not in this repo; the whole point of the sentence is that one of them stopped existing THERE. -->
dependency-cruiser 18.3.0 had renamed the CLI entry point
`bin/dependency-cruise.mjs` to `bin/dependency-cruiser.mjs`, and the vendored archmap walks
`node_modules` for the old name alone — so the package was installed, complete and runnable, and the
resolver was missing. `^18` in `packages/core/package.json` admitted 18.3.x, so every npm
dependency-group PR met it: #369, #394, #425 and #448 closed unmerged and #509 failed twice, each
told only that this repo's scope matched nothing. The root `package.json` now pins
dependency-cruiser to exactly 18.2.0 and `.github/dependabot.yml` ignores every newer version. Both
go when archmap releases its resolver fix (archmap ISS-10) and `archmap install --force` re-vendors
it (ISS-1354). The `archmap-resolver` prerequisite resolves the
entry point archmap actually spawns, and `check-archmap-ready.mjs` runs the same table in the CI job,
which runs the vendored binary directly rather than through `verify`. A directory is not a tool; name
the file the gate executes (ISS-1098).

That covers the class "archmap has no resolver to spawn". It does **not** cover "the resolver ran and
failed" — an unparseable report, a crash, a timeout, a missing tsConfig — because archmap discards
the provider's reason whenever another provider returns an empty-but-ok graph, which in a repo with
no `go.mod` is always. That half is archmap's, filed on that project, and no path on disk can stand
in for it.

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

- (none) — the whole gate, every check
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

**Both sides of a direction check are read out of git, never off disk.** `ratchetFault` in
`lib/baseline-ratchet.mjs` reads the declared baseline at the revision `baseRevision()` returns and
again at `HEAD` — so a
baseline file corrected in the working tree is invisible to it, and `pnpm verify` goes on reporting
the committed number until the fix is committed. The other checkers read the tree, which is why the
two can disagree inside one run: a checker can pass on a file the working tree has already
brought back under its number while this one still faults on the number `HEAD` holds. Commit the
baseline, then re-measure.

An axis whose probe is not on disk has **no measured level** — reported as `n/a`, compared against
nothing, and taking the script to exit `2`. Level `0` is not the answer there: `0` means "no checker
exists", a measured fact about the repo, and returning it for an absent binary reported three axes
as having lost their gates. `conformance-audit.mjs` draws the same line for `R7`, its one rule that
runs a tool: `n/a` rather than a rule this repo fails, and exit `2` before either profile verdict —
a `--` mark means the rule does not apply, `n/a` means it applies and was not answered.

## check-api-contracts.mjs — the published contracts are the code's

`packages/core/contracts/` holds the two artifacts a contract differ reads: `forge-api.openapi.json`
(OpenAPI 3.1) and `forge-mcp.tools.json` (`{name, description, inputSchema}` per tool, sorted by
name). `pnpm --filter @forge/core contracts:generate` writes both; this checker runs the same
generator into a scratch directory and compares bytes. Exit `0` equal · `1` drift or a refusal ·
`2` could not run.

**Generated from the running app, not from a second description.** The generator imports `app`
from `packages/core/src/index.ts` and walks `app.routes`, which is what Hono itself dispatches on,
so a route is in the contract exactly when it is mounted — including the `/` and `/api` twins and
the feature-flagged ones at their shipped defaults. A route's inputs come off the validators it
holds: `packages/core/src/middleware/zod-validator.ts` is `@hono/zod-validator`'s middleware
unchanged, keeping the schema against the middleware it returned, and `packages/core/biome.json`
refuses importing the library anywhere else — a validator built past the wrapper would leave its
route looking unvalidated. The environment is replaced, not inherited, so a `FEATURE_*` variable in
the caller's shell cannot mount a different route set.

**What the contract does not say, it says it does not say.** No route declares a response schema,
so every operation carries one `default` response whose description reads *Undeclared* — the same
text everywhere, so a differ sees a response being declared as the change it is. `x-forge-validated`
on each operation lists the request parts (`json`, `param`, `query`) a validator holds. A body no
zod schema can hold — multipart, raw bytes, a payload kept raw for its signature, the MCP transport's
JSON-RPC — is declared with `rawBody(contentType, description)` from the same module, and the
contract carries its media type and description and nothing else. A path parameter with no
validator is described as any string, which is what its handler accepts. `x-forge-input: none`
marks an operation that reads no input. A zod refinement is not JSON Schema: each `refine()` is
named under `x-forge-refinements` by the message it refuses with, and its predicate is not
described. `x-forge-auth` lists the gate middlewares the route runs before it answers, in order,
each defined under the document's `x-forge-auth-gates`; they are read off the gate itself
(`packages/core/src/middleware/declared-gate.ts`), so an empty list means no gate middleware, not
that no handler checks a credential of its own. A coerced date is described as a `date-time`
string, the convention zod uses for every coerced input.

**A read no validator declares is refused, so the gap cannot regrow.** The generator reads each
handler's own source and refuses `METHOD /path` when it reads a body (`c.req.json()`,
`parseBody()`, `arrayBuffer()`, `c.req.raw`, …) with no json validator and no `rawBody()`, a query
(`c.req.query()`, `new URL(c.req.url).searchParams`) with no query validator, or `c.req.valid(part)`
for a part nothing validates. A read inside a helper is not in the handler's text, so it also
refuses, by file and line, any `c.req.json()` or `c.req.query()` anywhere under
`packages/core/src` outside a test.

**A route the generator cannot describe is refused by name**: a wildcard or optional path segment,
two routes reaching one OpenAPI path, a `use()`/`all()` entry covering no route, a query validator
that is not an object, a param validator naming a param the path lacks, and any schema holding a
type JSON Schema cannot represent. Each is red here, naming `METHOD /path` and the reason.

**One generation per tree in CI.** Generating imports the whole app, about 14 s. With
`FORGE_API_CONTRACTS_DIR` set, this checker keeps the generator's result there stamped with a hash
of `HEAD`, the working-tree diff and the untracked files, and a later run whose tree hashes the same
reads it instead of generating; any other stamp is regenerated over. The conformance job sets it on
this step and on `conformance-status`, whose probe runs this checker again.

Canonical form: keys sorted recursively, arrays kept in order, two-space JSON with a trailing
newline, paths sorted by code unit and methods in OpenAPI's order. `info.version` is `unversioned`
on purpose: `package.json`'s version moves at every release cut, and a contract version is the
differ's to assign, not the build's.

### Adding a check

Append to `CHECKS` with a `scanned` regex matching that checker's own success line. Without one the
fail-closed contract cannot hold for it. If you add the step to CI too, add it to `CI_COVERAGE` in
the same commit — `--ci-parity` fails otherwise, which is the point.

## Level 1 is forbidden, and three rules say so rather than this paragraph

A check that runs, prints, and blocks nothing has no baseline to be held to, and every gate this
repo lost was at level 1 while documented as blocking. A check you cannot pass on the day you add it
is frozen at level 2 that same day — never merged at level 1 behind a comment promising cleanup.
`continue-on-error: true` is the same shape written in YAML.

**R8** fails on a CI step that cannot fail. **R9** fails on a biome rule left at a severity biome
exits 0 on, with no exception: nothing counts such a rule since the size ratchet was retired. **R10** fails on an axis that does not declare a
numeric level of at least 2 — including by omitting the key or quoting the digit. None of the three
is a number to read; each is a build that goes red.

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

`scripts/lib/lockfile-transport.mjs` holds the classification; the CLI reads the tree and exits.
Exit `0` clean · `1` an entry resolves over SSH · `2` no lockfile, or a lockfile
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

Two accepted schemes — `ISS-<seq>-<slug>` for the pipeline and `<type>/<slug>` for an external
contributor — plus three exempt names, `main`, `master` and `HEAD`, and one derived: the branch this
checkout's work lands on, read through `lib/base-branch.mjs`. Derived rather than listed because a
list here said `main` and would have refused a push of the base branch itself the day this
repository moved off it. With no `node` on `PATH` the three literal names still stand, which is the
exemption this script has always had.

## lib/base-branch.mjs — one answer to "which branch will this land on"

Every delta-scoped gate here needs a base revision, and until ISS-1304 each of them wrote
`origin/main` into its own source. A repository that moves its base off `main` breaks all of them
**silently**: a budget measured against the wrong merge-base reports a pass, and
`check-migration-order` hands back a `when` another branch has already spent.

`mergeTarget(root, env)` derives it, reading no configuration anywhere — the per-project config a
plugin keeps is one machine's file and GitHub Actions never sees it, so a gate sourcing its baseline
there would be right on a laptop and silently wrong in CI. Four sources, each **establishing** the
target rather than inferring it, and each named in the refusal:

| | source | when it answers |
|---|---|---|
| 1 | `$GITHUB_BASE_REF` | a `pull_request` run: the base of the pull request being built |
| 2 | `$GITHUB_REF` naming a branch on a `push` or `schedule` event | a push: the branch that took the commit; a schedule: the branch whose head it checked out |
| 3 | `inputs.base` in the `$GITHUB_EVENT_PATH` payload | a `workflow_dispatch` run: the branch its dispatcher said the work lands on |
| 4 | `refs/remotes/origin/HEAD`, confirmed by `git ls-remote --symref origin HEAD` | everywhere else: the remote's recorded default, held to what the remote names now |

Row 3 exists because `$GITHUB_REF` on a dispatch is the branch being run, not where it lands, and
`actions/checkout` records no `origin/HEAD`: run 36764719955 dispatched a branch and
`check-migration-order` exited 2 there, and the nightly `schedule` run would have too without row 2.
A dispatch naming no `base` is refused by name and reads no row after it — `origin/HEAD` is the
default branch, which is not where every dispatched branch lands.

The ref and not `$GITHUB_REF_NAME` in row 2, because a tag push is a push event and carries a ref
name too — `runner-release.yml` fires on one.
<!-- doc-citation: unchecked `refs/heads/` — a git ref namespace, not a path in this tree. -->
What says a branch took the commit is the `refs/heads/` prefix, and row 2 requires it.

**There is no rung reading the sole remote-tracking branch.** A plain `git clone --depth 1`
records `origin/HEAD`, so such a rung would only ever have answered for `--depth 1 --branch <b>` —
the one shape where the branch fetched need not be the branch the work lands on. It could not tell
"the only branch here is the target" from "the only branch here is the one somebody asked for", and
a wrong floor from it is the silently skipped migration. That checkout is refused, naming
`GITHUB_BASE_REF=<branch>` for the branch the work lands on, and `git remote set-head origin -a`
where that is the remote's default.

**Nothing falls back to `main`.** `baseRef(root)` then resolves the branch to `origin/<b>`,
`refs/remotes/origin/<b>` or `<b>`, and refuses naming all three rather than measuring against a
branch this change does not derive from.

Row 4 is checked against the remote because the record does not move when the remote's default
does: a clone taken before the default moved would measure the old base with nothing said. Where the
remote names another branch, row 4 refuses, naming both: `GITHUB_BASE_REF=<the recorded branch>` for
work that lands where the record says, and `git remote set-head origin -a` only for work that lands
on the remote's new default — on this repository's dev work, that advice alone would measure against
`main` (`lib/base-branch.test.mjs`). Where
the remote cannot be asked — unreachable, or silent past 10 s, which stderr says in those words —
the record stands and stderr says it went unconfirmed and which command confirms it.

Row 4 is the repository's own statement of what a pull request from this checkout targets, which is
the merge target for any change taking the default base. For a local run aimed at some other base,
`GITHUB_BASE_REF=<branch>` in front of the command scopes it; CI needs nothing, having row 1.

`branchSetFaults(ciYamlText, target)` is the other half, and `conformance-audit` R11 runs it: a
workflow trigger cannot read a variable, so the branches CI gates are written three times over —
the push trigger, the pull-request trigger, and the step deciding a tree a pull request already
proved. The three must name one set, and the merge target must be in it.

## check-migration-order.mjs — a migration is ordered against the set, not against `main`

A journal read alone proves only that its head `when` clears the maximum in that same file. Every
branch passes that alone, while the SET of open branches — the thing that actually has to be
applicable — is measured by nothing else.

<!-- doc-citation: unchecked `drizzle-orm/pg-core/dialect.js` — a file inside the drizzle-orm dependency, not this tree. -->
Drizzle's migrator reads the single highest `created_at` in `drizzle.__drizzle_migrations` once and
then applies only entries whose `when` exceeds it
(`drizzle-orm/pg-core/dialect.js`, the `Number(lastDbMigration.created_at) < migration.folderMillis`
arm). An entry below that mark is not reordered — it is skipped, silently, for ever. ISS-807 is what
that looks like afterwards: the container served new code against an old schema and the symptom was
a live 500 on `GET /me/attention` for every signed-in user.

**What it asserts, exactly one proposition:** the migrations THIS tree adds to its merge target can be
applied in some order of whole-branch merges alongside every open branch's live ones. Five refusals,
each naming the branches, the tags and the numbers:

| rule | what it catches |
|---|---|
| `below-floor` | a `when` of ours at or under the merge target's highest — the entry drizzle will skip |
| `duplicate-when` | two branches on one number; whichever merges second is skipped |
| `duplicate-idx` | two branches claiming one migration index |
| `inverted` | an index above a sibling's whose `when` is below it, so the merged journal is not monotonic |
| `interleaved` | `when` ranges that straddle — a branch merges whole, so no order applies both |

`interleaved` is the one no per-entry rule finds. Branch A holding 289 and 291 while B holds 290 has
every entry distinct and every index ascending with its `when`, and is still unorderable: whichever
lands first raises the high-water past the other's remainder.

**A branch cut from another carries its migration, not a second one.** Where two branches hold the
same tag at the same index and `when` (`lib/migration-order.mjs:sameEntry`), that is one migration
landing with whichever branch merges first; the other then reads it as already landed. No rule fires
on that pair, and `interleaved` measures only what each branch adds of its own. What a stacked
branch adds still meets every rule. Born when release-page-web, cut from release-page, held its 0478
and the check read it as a `when` spent twice (`scripts/lib/migration-order.test.mjs`).

**The unit is the branch.** A sibling already at or below the floor is STRANDED — it cannot land in
any order until it renumbers — so it is reported on its own and counted against nobody. Refusing
this tree for it would be refusing a branch for damage it cannot repair. Our own below-floor entries
are never filtered that way: that entry is the subject.

**Two OTHER branches that clash cost the claim, not the exit.** The five rules also run over every
pair of live siblings. Pairwise compatibility with this tree is not the whole-set proposition — a
tree at 292 conflicts with neither A={289,291} nor B={290} while A and B cannot both land — so a
run that printed a merge order there would be naming an order nobody can execute. Such a pair is
named, no order is printed, and this tree's own exit is unchanged, because it is not the tree that
can repair them.

**On CI the checkout is detached** on `refs/pull/N/merge`, where `git rev-parse --abbrev-ref HEAD`
answers `HEAD`. Three readings say "this is us" and a ref matching any is not a sibling: the name
HEAD is on, `GITHUB_HEAD_REF`, and any ref this tree already contains. Without them the PR's own
branch is read as a sibling holding every one of its migrations, and every migration-bearing PR is
refused against itself. The floor is re-read after the check's own fetch for the same reason in
reverse: a cached base branch is a floor the remote has already left behind.

**Exit codes.** 0 applicable · 1 a refusal · 2 could not run. A tree that adds no migration exits 0
without touching the remote and says so, which is a proposition proved from local data rather than a
failure to reach anything. A tree that IS the merge target reads the set for the stranded report
alone and exits 0 whatever it finds, because a branch that has landed is not the tree that can
repair anybody's numbers. **A tree landing a
migration that cannot enumerate the open branches is exit 2**, naming the migrations — a check that
cannot see the set has proved nothing, and a pass there would be the silent substitution the whole
gate is about.

**A branch git cannot read is an unknown, and an unknown is not an absence.** A branch carrying no
journal carries no migration and is nothing to order against, so it is passed over — but that
absence is established POSITIVELY, by listing the ref's tree. Probing the path with `git cat-file
-e` instead answers non-zero for "not in this tree" and for "git could not inspect the object"
alike, and reading that one number as absence drops the branch from the measured set and exits 0 on
a merge order derived from what was left. A tree that will not list, and a journal that lists and
will not read, are each exit 2 naming the ref. The reds for it are planted against the object store
rather than the parser, because the parser is a different failure with the same exit code.

### What it cannot catch

Two, and they are the same shape: the check runs before the merge, and the merge decides.

- **A merge taken out of the derived order.** Landing a higher branch first is permitted — refusing
  it would let one abandoned branch block every other. The cost is a renumber, not a loss: the
  branch behind it goes `below-floor` on its next run rather than losing its migration on deploy,
  and both sides are told — the lander is shown who it will strand, `main`'s own run after the merge
  names who was stranded.
- **A stale green carried through by a branch that never re-ran.** The refusal above only reaches
  the stranded branch when that branch runs the check again before merging.
  Branch protection's `strict: true` forced exactly that run, and ISS-1370 has the owner turn it
  off; the live ruleset is not readable from a checkout or from the Forge GitHub App's verbs, so
  which one holds is not verified here. With `strict` off that one path reaches the loss again, and
  `main`'s advisory is what still speaks.

Neither is reachable by a branch-time check, which is why they are written here rather than left to
be discovered. The rule it replaces was a CLAUDE.md instruction to a person — *read every unmerged
sibling's journal immediately before the landing push* — which could not hold: it was checked at a
moment a sibling could invalidate a minute later, and it scaled as N².

## check-release-record.mjs — the record of what shipped may not lose entries

`CHANGELOG.md` is the external record of what shipped, and until 2026-08-28 nothing owned it.
Commit `3df9a8e9` removed **1,034 lines, added 0** — the whole `[Unreleased]` block, every released
version section and the style header — inside a commit about closing 94 dangling docs pointers whose
message never named the file. Twelve gates ran on it and every one passed.

The record is two places: `CHANGELOG.md`, which holds released version sections only, and
`changelog.d/`, which holds each unreleased entry as a file of its own,
`changelog.d/<name>.<section>.md` — the name the branch or issue that writes it, the section one of
`added`, `changed`, `fixed`, `removed`, `security`. `scripts/cut-release.sh` folds the fragments into
the new version section through `lib/assemble-release.mjs` and deletes them in the release commit.
Two fragment forms feed What's new, which reads the running build's `CHANGELOG.md`
(`packages/core/src/whats-new/changelog.ts`): an entry may close with one line `tour: <id>`, folded
as an invisible `<!-- tour: <id> -->` the entry's "Show me" is read from, and a week's digest is
`digest-<year>-w<nn>.digest.md`, folded under `### Digest` as `<!-- digest: <week> -->` and held to
`DIGEST_WORD_BUDGET` words instead of `ENTRY_WORD_BUDGET`.

**Why fragments.** While unreleased entries were lines under `## [Unreleased]`, a release inserting
its version heading under that line and a branch appending an entry below it edited neighbouring
lines of one file. Git's merge then either conflicted or put the branch's entry into the section the
release had just cut — every release from dev.56 to dev.62, six hand repairs in a day, and one run
skipped its entry because the file was held by another tree.

<!-- doc-citation: unchecked `newsfragments/` `.changes/unreleased/` `.changeset/` — the fragment directories of towncrier, changie and changesets, in their own repositories -->
One change, one file at a path no other branch writes, is the shape towncrier (`newsfragments/`), changie (`.changes/unreleased/`) and
changesets (`.changeset/`) all settled on; none of them was taken because the release writer was a
dozen lines of the same job and this gate is the larger part, which none of them carries.

Rules:

| | Fails when |
|---|---|
| `unreleased-in-record` | `CHANGELOG.md` carries a `## [Unreleased]` heading — a writer following the guidance fragments replaced. Each entry under it is named with the fragment path to move it to |
| `entry-outside-a-fragment` | an entry this change adds sits in a version section the base revision already held, and is not a correction of a published entry — the merge that slid a branch's entry under a release. A version section new at HEAD is a release, or several in a promotion, and passes |
| `fragment-shape` | a file under `changelog.d/` is not named `<name>.<section>.md`, is empty, holds a heading, a list marker or a second paragraph, or does not open with a bold lead; a digest is not named `digest-<year>-w<nn>` or carries a `tour:` line |
| `structure` | one release section carries the same `###` heading twice, or an entry this change adds is followed by prose a blank line cut off from its bullet |
| `no-silent-loss` | an entry present at the base revision is absent at HEAD, is not an edit of one that is present, and nothing declares the removal |
| `entry-budget` | an entry this change adds runs over `ENTRY_WORD_BUDGET` words, or one it corrects runs over the larger of that budget and what the entry already held. The refusal names each entry with the ceiling actually applied to it and whether it paired as a correction, because an inherited ceiling advertised to an entry that did not inherit one reads as a rule the checker is not following |

Entries are compared as a **set of whitespace-normalised texts, position-independent**, across
both places: every bullet in `CHANGELOG.md` and every fragment. That is what lets a release move an
entry from `changelog.d/` into a version section without losing one, and why deleting a fragment
nothing released is a loss like any other; a positional comparison would turn the next release red. Normalising whitespace is what stops a hard-wrap reflow reading as
30 deletions.

### A correction is an edit, not a deletion and a new entry

Until ISS-1145 an entry was kept by the byte identity of its whole normalised text, so changing one
word inside a 172-word entry was one removal plus one 172-word addition — `no-silent-loss` and
`entry-budget` refusing the same bytes in opposite directions, with an amnesty for one and none for
the other. No published entry could be corrected at all, which is what held `main` red on the `docs`
job: `CHANGELOG.md` linked `docs/flows/issue-work.html`, a directory `c74d9b3f7` deleted, and the
only edit that would fix it was the one edit the gate refused.

`matchEdges` in `lib/entry-correction.mjs` matches each removed entry to at most one added entry.
**Two entries are the same entry when more than half the words of the longer one survive into the
other in order, AND the change moved at most `CORRECTION_SPAN` words each way** — at most that many
of the published entry's words gone, at most that many new ones standing where they were. A paired
entry is neither a loss nor an addition, and it answers to the larger of the budget and what the
entry it replaces held, so a correction never buys words. A wider change is a withdrawal and a new
entry however much of the wording it carries over: it pays the budget as a new entry and its removal
still needs the amnesty row.

**The share alone was not enough, and no share is.** ISS-1145's first round shipped the share by
itself, and a review of the merged head found the hole from the other side: the share of a long
entry that survives is buyable with background prose. A 120-word entry holding 61 words of
background beside a 59-word claim scores 61/120 with that whole claim replaced by an unrelated one
— the removal reads as a correction, the replacement inherits the 120-word ceiling, and the record
is rewritten under a green gate. Raising the share moves the ratio and nothing else, because an
entry padded to any ratio has the remainder free. An absolute span cannot be padded into.

Both bounds are measured on this record rather than picked. The share: 14,270 sampled pairs of
DIFFERENT entries peak at 0.250, while the corrections `.forge/changelog-amnesty.json` already
declares run 0.469 to 0.996. The span: over every commit that has touched `CHANGELOG.md`, the widest
change that is plainly still the same entry moved 9 words in and 16 out (`226ddf039`), and the
narrowest that is plainly a different claim moved 52 in and 54 out (`021b26c2a`) — which clears the
share at 0.578, so the adversarial shape is already in this repo's own record and the span is what
refuses it. `CORRECTION_SPAN` is 16.

**The allocation takes the most pairs, not the likeliest one.** Sorting candidates by similarity and
taking each irrevocably lets two genuine corrections in one change refuse each other: where a removed
entry's best match is also the only match another removed entry has, the greedy answer reports one
entry lost and the other over budget while a pairing satisfying both exists. `bestMatching` grows the
matching along augmenting paths, so a pair already held is given up to buy two, and similarity only
breaks ties between pairings of the same size.

### Prose a blank line orphaned is named, not dropped

A blank line ends an entry, so a bullet's second paragraph belongs to no bullet: `parseRecord` drops
it, and neither the loss rule nor the budget can see it. That
was tolerable while every entry was compared by byte identity, and it stopped being tolerable the
moment corrections paired: a published 50-word bullet split after word 40 by a blank line leaves a
40-word bullet that pairs with what it truncated, inherits its ceiling, and passes green — where the
same edit before ISS-1145 raised `no-silent-loss`. Ten published words leave the record and the gate
reports nothing, which is the silent substitution CLAUDE.md refuses, made by the gate that exists to
catch it.

So an entry the change ADDS that carries orphaned prose is refused under `structure`, before the
pairing runs, and it is excluded from the pairing: the truncation is named as a truncation rather
than forgiven as a trim. The refusal says how to join the prose back — an indented continuation with
no blank line — or to give it a bullet of its own.

**Only prose this change added.** The published record carries 1,718 such lines under 2-space
indents, inherited from before anything bounded the file, and refusing those would turn every change
red on bytes nobody in it wrote — the opposite of the rule's own promise that nothing already
published turns it red. Prose already orphaned at the base revision is therefore grandfathered, so
an entry may still be corrected with its paragraphs left as they are, which is what ISS-1112's
citation sweep needs.

**The exemption is an edge the pairing runs over, and the pairing stays one-to-one.** Three readings
of "already published" were tried and two of them were holes, so the shape is worth stating in full:

| Read as | Hole |
|---|---|
| a set of every orphaned text in the record | transferable — an unrelated published bullet whose paragraph holds the same words exempts a fresh truncation elsewhere, and a change can arrange that |
| a test applied to the pairing once it is chosen | the matching maximises pairs and then similarity and knows nothing of paragraphs, so two corrections whose CROSS pairing scores higher are each handed the other's predecessor, both refused, and the valid pairing is unreachable once they are excluded |
| any predecessor the rule admits, asked of the edges | pairwise feasibility is not a joint assignment: two added entries both borrow the one predecessor's paragraph, the matching pairs one, and the other is a brand-new unpaired entry whose prose is dropped in silence |

What holds is the third question asked of the *assignment* rather than of edge existence.
`correctionEdges` is split out of `matchEdges`, an edge from an orphan-carrying added entry survives
only where that removed entry already carried exactly that prose, and the matching is run over what
is left. An orphan-carrying entry the matching does not pair is refused — so one predecessor exempts
one correction, which is the same one-to-one rule corrections already answer to. What is NOT covered: prose orphaned under a `###` heading with no
bullet above it at all — the record holds none, and there is no entry to attach it to.

**What the pairing does not claim.** A change inside the span can still reverse what an entry says —
one word can — and no rule that counts words can tell that from a typo fix. The gate bounds how much
of the published record one change may replace without declaring it; the meaning of a narrow edit is
the diff review's, which sees it as two lines.

Base revision comes from `baseRevision()` in `lib/baseline-ratchet.mjs`, which returns the revision,
the rung it came from and a refusal, and is the only form the base is handed out in — so no reader
holds the revision without the reason it is missing. The rungs: the merge-base with the merge target
`lib/base-branch.mjs` derives; where that is `HEAD` itself, on a push to the branch, the payload's
`before`, so a push of several commits is judged as one change rather than by its last commit; and
`HEAD~1` only for a local checkout standing on its target's tip and for the push that creates its
branch. A target that cannot be derived, names no ref here or shares no history with `HEAD`, and a
push whose `before` cannot be read or is not an ancestor, are refused by name rather than shortened
to `HEAD~1`, which would judge one commit of many and say nothing. **No base revision is exit 2**,
which is why `lang-check` carries `fetch-depth: 0`. The checker prints the revision it judged against
and which rung gave it, and `conformance-status.mjs` prints the same refusal.

### Removing an entry is legal, and it is declared

`.forge/changelog-amnesty.json` holds one `{entry, reason}` per removal, the entry verbatim and the
reason non-empty. It is the ledger of every entry that LEFT the record — a removal is fine, a
removal nobody can see is not. Its rows written before ISS-1145 are mostly corrections rather than
removals, because a correction was the only shape the gate could not tell from one. It is not a bulk
baseline and there is no `--update-baseline` — a public record is edited one line at a time or not
at all, and `entry-budget` has no amnesty at all.

```bash
node scripts/check-release-record.mjs      # 0 the record holds · 1 it was broken · 2 could not run
```

The verdict half is in `lib/release-record.mjs`, the fragment shape in `lib/changelog-fragments.mjs`
and the correction pairing in `lib/entry-correction.mjs`, so each can be tested without a git tree;
the CLI reads git and exits.

## merge-check.mjs and test-changed.mjs — the direct tests of a change

REQ-36 BC-7, BC-9, BC-15 and BC-17, as Issue to release r20 draws `rule-merge`. One selection,
`lib/direct-tests.mjs`, serves both: a test is **direct** for a touched file when it is that file,
when one of its own import specifiers resolves to it (relative, or through its package's tsconfig
`paths`; `vi.mock` counts), or when it declares the file in a comment line of its own,
`// @direct-test-of <path>` (a trailing `/` covers a directory). Nothing goes further: no import
graph, and no share of a suite that turns a selection into the suite: the selection of a set of
touched files is the union of each file's own, at any count (`lib/direct-tests.test.mjs`). A touched
code file no test reaches is printed, never covered by running more. Every package is in it: core's unit and
integration tests, web-v2, contracts, observability and `scripts/` each under the vitest config
that collects them, and the runner by crate — the touched module's own tests, inline and in its
tests file beside it (a module named `tests` or ending `_tests`), read from `cargo test -- --list`
and run `--exact`, and a touched integration test file under a crate's tests directory as
`--test <name>`.

**The declaration is how a miss widens.** A test that reaches its subject by URL, by table name or by
reading a file reaches it by no import, so the merge check cannot see it. When the whole suite goes
red and the bisect names a merge whose merge check passed (`rule-suite`), the fix declares the path
on the test that caught it; that change kind selects it from then on. The selection grows, the suite
size at a merge does not.

**What was selected is what ran.** `lib/direct-test-run.mjs:runDirectTests` runs each collection's
selected files and each crate's selected tests, and then holds the selection against the checks it
made: a selected test file, runner module or test target no check reached is a red check of its
scope, `DIRECT_TESTS_NOT_RUN`, naming the files. "No test file is direct for any touched file" is
said only where nothing was selected. Vitest is never handed a collection with no file, which would
run the whole collection. `lib/direct-test-run.test.mjs` drives the run layer over a fixture
repository with its commands recorded, and holds both entrypoints to starting no test runner of
their own.

| Command | When | What it runs | Exit |
|---|---|---|---|
| `pnpm test:changed [--integration] [--report <path>]` | before a push | `tc-changed`'s typecheck (and `cargo check` when the runner is touched), the direct tests of what changed against the merge-base with the target, committed or not, each timed; writes the checks' report | 0 · 1 a check red · 2 could not run |
| `GITHUB_BASE_REF=dev pnpm merge-check` | before landing on dev, and in `ci.yml`'s `merge-check` job | fetches the base, refuses `MERGE_BEHIND_BASE` unless HEAD holds its tip and a dirty checkout by name; then the typecheck, the direct tests, the direct core integration tests and `pnpm verify`, each timed; writes the report | 0 · 1 red or behind · 2 could not run |
| `pnpm merge-check --since <sha>` | a push run on dev | the same over a landing already on the base, `<sha>..HEAD`, recorded as `landed` | as above |
| `pnpm merge-check --lane fast` | a change a person approved in its live preview (REQ-39 BC-7) | the fast lane: `rebased-on-base`, the typecheck and the direct tests only — no integration tests, no `verify`; the report carries `lane: 'fast'` and the change's `patchId` (`git diff --binary <base> <head> \| git patch-id --stable`), which core holds to the approved preview's and refuses `FAST_LANE_*` by name | as above |

**Every check is timed once** (REQ-36 BC-14, ISS-474). `lib/direct-test-run.mjs` makes each check a
check run as `packages/contracts/src/check-runs.ts` declares it: an id of its own, its kind
(`tests`, `typecheck`, `conformance` for `pnpm verify`, `base` for `rebased-on-base`), when it
started and how long it took. `test:changed`'s report (`{ head, checks }`, `--report <path>`, the OS
temp directory by default; a check run on a dirty checkout says so in its note) is the body of
`POST /api/issues/:id/checks`, which records each on the run session holding the issue on the box
that sent it; a resend adds nothing. Probes and the review are kinds no script here runs yet, and a
check run by hand outside these scripts is timed only if its run sends it.

**The record.** The merge check's report (`--report <path>`, the OS temp directory by default) is the
body of `POST /api/issues/:id/merge-check`, which refuses `MERGE_CHECK_INCOMPLETE`,
`MERGE_CHECK_KIND_MISMATCH`, `MERGE_BEHIND_BASE`, `MERGE_CHECK_RED` and `PATTERN_ENTRY_MISSING` by
name. A passing check records its checks as check runs, each with its kind and duration, and
core's `verification` record naming them — never a second copy of a duration. The
checks every merge needs are `REQUIRED_MERGE_CHECKS` in `packages/contracts/src/merge-check.ts`,
and `lib/merge-check.test.mjs` holds `lib/merge-check.mjs`'s copy to it, as it holds `FAST_LANE_CHECKS`
to `FAST_LANE_MERGE_CHECKS` in `packages/contracts/src/fast-lane.ts`. Kept probes (ISS-469) and
the review (ISS-473) join that list when their issues land; until then each report names them as
not run. A mark the project's `validation.mergeCheck: required` or an approved new pattern owes a
check is refused `MERGE_CHECK_MISSING` until a passing one stands at the commit marked.

**Where CI runs it.** A push to `dev` and a pull request into `dev` set the `changes` job's `scoped`
output, which runs `merge-check` and skips every other job; there `ci-passed` is red unless
`merge-check` succeeded, a skip included, while on every other event it accepts the skip as it
accepts any skipped job's. `lib/ci-passed.test.mjs` runs `ci-passed`'s own step from `ci.yml` under
each event's job results. A pull request is
checked at its head, not at GitHub's merge ref, so a branch behind `dev` is refused rather than
merged untested: branch protection's `strict` is off. `main`'s events never set `scoped`, so they
run the jobs they always ran, with `merge-check` skipped. `verify` runs no test suite: the
runner's `cargo test --workspace` left `check-runner-gates.mjs` with this change, and the
pre-push hook's `PREPUSH_TEST=1` runs `pnpm test:changed` where `PREPUSH_FULL` ran whole suites.
The hook tells its exit 1 (a check red) from its exit 2 (it could not run, so nothing was checked),
and `PREPUSH_BUILD=1` measures a new branch from its merge target (`lib/base-branch.mjs`), refusing by
name where none resolves; `lib/pre-push.test.mjs` runs the hook in a fixture repository. A landed
push run (`--since`) says it checked what already landed, and asks for no record before a mark.

## whole-suite.mjs — the whole suite on one commit, the cut it gates, and the merge it names

REQ-36 BC-10 and BC-11, as Issue to release r20 draws `rule-suite`. A **whole-suite run** is `ci.yml`
on a schedule, or dispatched with `-f suite=whole`: the change filter is not consulted, every job
runs, and the `whole-suite` job concludes success only when every one of them succeeded. A skipped
job is red there, which is the opposite of `ci-passed`, because a whole suite that skipped a job did
not run the whole suite. No push or pull request reaches it (BC-17).

**A `whole-suite` check concluded `skipped` is no record.** Every run that is not a whole-suite run
(a push, a pull request, a dispatch without `suite=whole`) skips the job, and GitHub still records a
completed check run, concluded `skipped`, on the commit. The gate and the bisect both read past it:
it neither passes a cut nor refuses one, and it never stands in for a test result. On `main`, where
every push leaves one, reading it as red refused every cut and blamed the first landing after the
last green run (ISS-471's independent judge, comment 9da9b859).

| Act | Where it runs | What it reads | What it answers |
|---|---|---|---|
| `gate --commit <sha> --branch <b> [--dispatch [--wait <min> --poll <s>]]` | `cut-release.sh` step 1b, on the box cutting | the `whole-suite` check on the commit; the CI runs in flight on it; a red run's jobs | 0 green · 1 `RELEASE_SUITE_NOT_GREEN` · 2 could not read |
| `bisect --commit <sha> --run <id>` | `suite-bisect`, on a red whole-suite run | the run's failing jobs; the first-parent landings since the last green whole-suite run, and the check runs recorded on each | the merge that broke it and the issue it names, or the range and every merge in it |
| `fanout --ran-on <branch>` | `nightly-fanout`, on a schedule | `on.push.branches` of `ci.yml` | a whole-suite dispatch onto every other gated branch |

**A cut ends green or red, not "come back later".** `cut-release.sh` runs the gate with
`--dispatch --wait`: with no whole-suite run on the commit it starts one on the branch head (which
is the commit), and waits for it (`CUT_SUITE_WAIT_MINUTES`, 40 by default, read every
`CUT_SUITE_POLL_SECONDS`, 30). A run already in flight is waited on, never doubled. A red run where
no job failed on its own steps (`cancelled`, `skipped`, a runner that never started) is rerun once,
because a rerun settles it and a fix does not; a red run where a job concluded `failure` or
`timed_out` refuses at once, naming the jobs. A cut that comes back later would find a newer head
with no run, every time, on a branch that lands several commits an hour, so it never would.

- **The branch moves while the suite runs.** The release commit stays on the commit the suite
  passed and is merged onto the branch's head, head first, so the first-parent history stays the
  branch's landings. A conflict refuses by name and pushes nothing. The cut says how many landings
  rode along: a deploy that builds the branch head carries them, untested by this cut's suite; the
  next cut's suite tests them before the release that claims them.
- **`--at <sha>`** cuts on an earlier commit of the branch, so a cut stopped while waiting (a tool
  time limit, a lost session) goes on waiting on the run it started instead of starting one on a
  newer head. A dispatch runs on the head, so `--at` on a commit with no run is refused.
- **`--no-push` is a rehearsal**: it reads, refuses as a cut would, and starts and reruns nothing.
- **A refused cut after a batch has claimed its roster.** With the wait, only a red on a test (or
  an unreadable GitHub, or a run the wait outlasted) refuses. A release run that aborts on it with
  `pushed: false`, `carried: []` and a person's blocker holds the roster, which stops an `on-land`
  project re-cutting it every sweep tick; the first release that ships a later commit closes the held
  rows against itself (`packages/core/src/release-batch/shipped-earlier.ts:closeShippedEarlier`), so no person has to
  act once the fix ships.

**The bisect reads, it reruns nothing.** A landing reads good on a green whole-suite run, or where
every failing job recorded success on it; bad where a failing job recorded failure. A red
whole-suite run is not read as bad by itself: it may be red for a job that is not failing now, or
for a cancelled leg, so its jobs' own checks on the commit are read as on any other run. A check of
another name is not read, since a merge check runs a selection and may not have run the test now
failing. The broken merge lies after the last good landing and at or before the first bad one after
it; where no record separates the landings between, the range is named whole. On dev, where a push
runs only the merge check, whose check run has a name of its own, the records are the whole-suite
runs each cut starts, so the range is the landings between two cuts.

**GitHub runs a schedule on the default branch only.** The nightly run is `main`'s, and dev's comes
from `main`'s `nightly-fanout` — so it starts once this `ci.yml` is on `main`. A dispatch made with
`GITHUB_TOKEN` is the one event that token may start a run with, which is why the fan-out needs no
other credential. Once this `ci.yml` is on `main`, `main`'s cuts are gated the same way: a pushed
commit there carries a skipped `whole-suite` check, which is no record, so its first cut starts the
whole suite and waits for it.

## check-source-language.mjs — English-only source policy

Fails if any `.ts`/`.tsx`/`.md` file under `packages/web-v2/src/` or `packages/core/src/` contains non-allowlisted diacritics. See ISS-65 for context — the project is English-only across UI strings, identifiers, comments, docs, and tests, after ISS-43 leaked Vietnamese copy onto `main`.

### Modes

- `--staged` (default): scans STAGED content of files in `git diff --cached --diff-filter=ACM`. No hook runs it on `dev`: `.githooks/pre-commit` is empty there.
<!-- doc-citation: unchecked `src/` — the plural: each package's own source tree, not one directory. -->
- `--all`: walks the working tree across both `src/` trees. Used by CI (`.github/workflows/ci.yml` `lang-check` job).

Exit codes: `0` clean, `1` violations found, `2` invalid invocation.

### Allowlist (per-line, evaluated in order)

1. **Brand-name literals** — small inline allowlist of foreign-glyph proper nouns (`Pokémon`, `café`, `naïve`, `résumé`, `cliché`, `façade`, `jalapeño`). If every diacritic on the line is part of an allowlisted brand, the line passes.
2. **Language picker entries** — line containing both `value: '<lang-code>'` and a `label:` token. Pattern: `{ value: 'vi', label: 'Tiếng Việt' }` legitimately needs the native script as the label value.
3. **`i18n-allow:` directive** — line ends with `// i18n-allow: <reason>` (or the `/*` / `<!--` variants). Same-line scope only; reason text is required.

### Bypass

CI cannot be bypassed — translate the offending strings or add an `i18n-allow:` directive with a reason.

## The web suite's language checks — Forge is not multilingual

The owner ruled on 2026-10-08 that Forge is not multilingual: the Vietnamese already written stays,
nothing more is translated, and new copy is English only. A key with no vi word reads its English on
a vi page (`packages/web-v2/src/lib/i18n/product-copy.ts:productCopy`, `copyOr`,
`productCopyTemplate`), proven on the Dashboard by `packages/web-v2/src/test/en-only-copy.test.tsx`.

Retired by that ruling, so no check makes a new key, enum value or core sentence carry a vi word:

- the vi walking test's English-word assertion (`packages/web-v2/src/test/vi-chrome.test.tsx`), its
  word list and the `translate="no"` and tooltip parsing that only it needed, and the same
  assertion over core's vi sentences in `packages/web-v2/src/lib/i18n/said.test.ts`;
- every "each English key has its vi" requirement: in `packages/web-v2/src/lib/i18n/copy-files.test.ts`,
  `packages/web-v2/src/lib/i18n/copy-readers.test.ts`, `packages/web-v2/src/lib/i18n/labels.test.ts`,
  `packages/web-v2/src/design/vocabulary-common.test.ts`,
  `packages/web-v2/src/features/workflows/template-words.test.ts` and
  `packages/web-v2/src/features/conversations/membership.test.ts`.

Kept, because they are about structure rather than language: the walking test still renders every
screen and refuses one that draws no words, a raw copy key, the marker for a key this build lacks, or a
blank label (`packages/web-v2/src/test/unread.ts:unreadIn`), and two rail rows whose English differs
reading as one vi word; a key two copy files hold (`packages/web-v2/src/lib/i18n/product-copy.ts:composeCopy`);
a re-added `product-copy.json` (`scripts/split-product-copy.mjs --check`); a vi word with no English, or
blank where its English is not; and a vi template that fills a value its key does not declare. Where a
vi word exists it is still read, and `check-source-language` still keeps Vietnamese out of source.

## check-lazy-module-init.mjs — importing a core module does no work

`packages/core/src/lib/env.ts` validates the whole environment on the first READ of `env`, and
`packages/core/src/db/client.ts` constructs the postgres pool on the first read of `db`. Both used
to do it at module scope, so importing anything whose graph reached either did that work — and on a
missing variable, threw inside the import.

That failure has no test in it.
<!-- doc-citation: unchecked `env.ts:137` `db/client.ts:3` `knowledge/service.ts:3` — quoted verbatim from a CI log. A stack frame records where a process was at one moment; it is evidence, not a citation, and rewriting it would falsify the quote. -->
CI on PR #457 reported `1 file failed` with the file itself reading
`3 tests | 3 skipped`, no assertion anywhere in the job, and a three-frame stack: `env.ts:137` →
`db/client.ts:3` → `knowledge/service.ts:3`. The unit suite is floored by
`packages/core/vitest.setup.ts`; `packages/core/vitest.integration.config.ts` carries no
`setupFiles`, which is where it bit.

A third export joined them with ISS-18: `RULES` in `packages/core/src/lib/rate-limits.ts` reads
`env` on every read, so a route file writing `rateLimit(RULES.x)` at module scope validated the
environment when imported. A caller now hands `rateLimit` a function returning the rule.

**An import is matched by where it resolves, not by how it is spelled.**
<!-- doc-citation: unchecked `config/env.js` `./env.js` — import specifiers as written in source, not paths in this tree. -->
Matching the specifier's tail — `config/env.js` — missed `packages/core/src/lib/rate-limits.ts`
for as long as it existed, because it sits beside `packages/core/src/lib/env.ts` and imports
`./env.js`; 22 import-time reads went unreported while this gate was green.
Resolving each relative specifier from the importing file closes that, and the lazy modules
themselves are scanned too rather than skipped.

This checker is what keeps them lazy, because the property is invisible in a green run: one new
module-scope read puts the side effect back for every module downstream of the file that does it,
and breaks nothing on the day it lands. No type can hold it — `env.UPLOADS_MAX_BYTES` is legal
wherever `env` is in scope, which is what an import is for — so the rule is a walk over the
TypeScript AST.

**The rule is "does this read run when the file is imported", which is not "is this read outside a
function".** Its consequences:

| Shape | Caught | Why |
|---|---|---|
| `const n = env.PORT` at module scope | yes | runs at import |
| `(() => env.PORT)()` at module scope | yes | an IIFE body runs at import — the first version of the checker climbed one parent and missed this, because `(…)` puts a `ParenthesizedExpression` between the arrow and the call |
| `import * as config` then `config.env.PORT` | yes | a namespace import reads the same value; a checker that understood only named imports would report the file clean |
| `class C { [env.PORT]() {} }` | yes | a computed member name is evaluated where the class is, not where the body is called |
| `cors({ origin: (o) => env.CORS_ORIGINS.includes(o) })` | no | a callback the caller invokes later, which is the shape the fix introduced on purpose |
| `Pick<typeof db, 'select'>` | no | a type query erases at compile time; 24 of core's 26 module-scope mentions of `db` are this, and counting them would make the gate 92% noise on its first run |
| a read in the THEN branch of `if (isMain) { … }` | no | the entrypoint guard is false precisely when another module is importing the file |
| a read in that guard's ELSE branch | yes | the else branch runs on every import, which is the case the guard is meant to be about not doing |
| `if (import.meta.url === import.meta.url) { … }` | yes | the comparison must name `process.argv` on its other side, or an always-true test would be a two-token way of silencing the gate |
| a read outside that guard in a module's index file | yes | the guard is a block, never a whole-file exemption |

The last four rows were holes this checker had on its first version, found by the whole-set review
of the change that added it.

**What it cannot hold**, stated here because a gate whose limit is unwritten gets read as holding
more than it does: a NAMED function called at module scope runs at import, and a syntactic walk does
not follow that call. Nothing in core does this today.

`--all` is the only mode, and the checker refuses anything else by name. A run that can narrow its
own scope reports clean on a tree that is not — which is also why the checker exports
`importTimeReads`, to be called with fixture text, rather than taking a `--scan-root` flag.

## check-test-signal.mjs — low-signal test guard

Flags a test FILE that is mostly
declaration-shape assertions (`.columnType` / `.notNull` / `.hasDefault` / `.primary` /
`.isUnique` / `.dataType`) — assertions that restate what the declaration already says and
so can only fail on an intended change. FK `.onDelete` is deliberately not flagged.
Zero tolerance since the baseline was deleted empty (`{ files: {} }`: nothing was frozen, so the axis
claimed level 2 over no old debt); an exemption would be a priced entry in `.forge/conformance.json`.

The registry read and the staged-file collection are
`lib/checker-config.mjs`; what lives in this script is the
analyzer — which files to read and what to count in them. Thresholds and regexes are
`checkers.test-signal` in `.forge/conformance.json`, and deleting that block degrades to the
built-in defaults rather than to an empty scope.

## lib/checker-config.mjs — the manifest reader

The checkers' shared read of `.forge/conformance.json`. It also held the per-file freeze
(ISS-848) until the last frozen baseline of that shape was deleted empty, and the freeze with it. What it holds is `readManifest` / `checkerConfig` / `scopeConfig` / `tunedConfig`,
`parseMode` and `stagedFiles` (an unreadable manifest or a failed `git diff --cached` is an error the
caller exits 2 on, never an empty answer a hook would report clean). What stays in each checker is
its analyzer.

`scopeConfig` refuses an absent manifest and `tunedConfig` degrades to defaults, which is not an
inconsistency: a scope list has no meaningful default, so inventing one measures directories the
manifest never declared, while `.forge/conformance.json`'s own `$comment` promises that deleting a
threshold block degrades to built-in behaviour.

`scripts/**/*.test.mjs` is collected by `packages/core/vitest.config.ts` and by nothing else, so
a test of a script runs under the `core` job — which `ci.yml`'s `changes` filter triggers on `scripts` as well as
on `packages/core`. Locally such a test needs `turbo.json`'s `test.inputs`: without
`$TURBO_ROOT$/scripts/**` a scripts-only change is outside `packages/core`, so `pnpm test` replays
a cached log and reports green over tests it never ran. Measured 2026-08-30 on the same touched
tree: cache HIT without that input, cache MISS with it.

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
| R11 | one branch set across the merge gate, and the merge target is in it | `ci.yml` triggered on `[main]` alone, so a pull request into any other base would have run no CI at all and reported no failure (ISS-1304) |
| R12 | every `ci.yml` job but `ci-passed` is in exactly one of its `needs`, `$postMerge.jobs` and `$wholeSuite.jobs`, and every declared job exists; `$wholeSuite`, which blocks the release cut, names an axis and a level 1-3 | nothing yet — written with ISS-1370, which took four jobs out of `needs`: without it the next job left out would block nothing and be declared nowhere. ISS-471 added the third list, and its axis and level once the independent judge found it had neither |

Profiles bound **shape**, never tool choice — `baseline` (one axis measures) · `standard` (two axes
block, both meta-checks) · `hardened` (every declared axis blocks, every needs-job asserted). "Two
axes blocking" ports to any stack; "must run biome" does not.

```bash
node scripts/conformance-audit.mjs      # 0 meets the claim · 1 does not · 2 cannot audit
```

Exit `2` on an unreadable manifest, an unknown profile name, or a manifest with no axis at all.
With no `profile` declared it reports the highest one the repo would meet and exits on the rules
alone.

It audits shape, not worth: a repo can pass all twelve with an axis measuring something pointless. That
is deliberate — choosing what to measure is the repo's call, and a tool that ruled on it would start
dictating stacks.
