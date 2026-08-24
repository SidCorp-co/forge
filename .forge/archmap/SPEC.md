# archmap/1 — specification

The contract. Every finding cites a section here.

Status marker: **[live]** implemented and covered by `tests/run.mjs`. It is the only one. A contract
type is either evaluated or not in the vocabulary — there is no tier for "validated but unchecked",
because a manifest that validates clean and is then never checked buys trust it has not earned.
`tests/run.mjs` binds the vocabulary to the evaluators in both directions, so the tier cannot come
back by accident.

## §1 Purpose

Compare a project's **declared architecture** against the architecture its code actually has, and
report the difference at the moment someone changes the code.

This is a Software Reflexion Model (Murphy, Notkin & Sullivan, FSE '95): a high-level model, a
mapping onto the source, and a computed difference. Naming it fixes the output shape — three
categories, not one (§3).

Corollary (§1.1): archmap carries only what a **dependency graph** can answer. Whether a split was
"by responsibility" is a judgement, not a measurement, and is out of scope by construction.

## §2 Principles

| # | Principle | Failure mode it kills |
|---|---|---|
| 1 | The CLI is the product; every surface is a thin caller | rules that only exist for whoever installed a plugin |
| 2 | Closed vocabulary; an unknown contract type is an error | the manifest degenerating into a bespoke linter |
| 3 | The checked party may never edit the criteria | a gate the subject can widen is not a gate (§8.3) |
| 4 | Never resolve what a mature resolver already resolves | reimplementing tsconfig paths and pnpm layout, badly |
| 5 | A scope that cannot be computed is never an empty scope | a broken invocation reading as a clean repo (§10) |
| 6 | Unresolvable is reported, never silently treated as absent | false confidence one layer deeper than regex |
| 7 | Status is per contract, and locking freezes rather than demands zero | the rule nobody can ever turn on |

## §3 The three results

| Result | Meaning | Where it surfaces |
|---|---|---|
| **convergence** | the model allows the edge and the code has it | silent |
| **divergence** | the code has an edge the model forbids | the gate — hook and CI |
| **absence** | the model expects an edge the code lacks | report only, never a gate |

**[live]** divergence. **[live]** absence — evaluated and counted on the verdict line, but excluded
from the gate on purpose: in a check
that fires on every edit, "not implemented yet", "only on some paths" and "model rot after a
refactor" are indistinguishable from "actually missing", and a check that is frequently wrong
teaches people to ignore the ones that are right.

## §4 Manifest

`.arch.json` at the repo root, validated against `schema/arch.schema.json`.

JSON rather than YAML so a vendored copy parses with zero dependencies. Rationale that would have
been a comment belongs in each contract's `description`, which the report prints alongside the
finding.

Top-level keys: `version` (must be `1`), `modules`, `tests`, `generated`, `exclude`, `size`,
`contracts`.

## §5 Contract vocabulary

Six types, closed. Every one of them is evaluated.

| Type | Says | Needs | Status |
|---|---|---|---|
| `layers` | ordered tiers; a module may depend on later entries, never earlier | import graph | **[live]** |
| `forbidden` | `from` must not depend on `to`; `to: "*"` means nothing outside itself | import graph | **[live]** |
| `independence` | these modules must not depend on each other, transitively | import graph | **[live]** |
| `boundary` | a module's public surface; cross-module edges must land on it | import graph | **[live]** |
| `fan-out` | a file or module may reach at most N distinct modules | import graph | **[live]** |
| `absence` | this dependency should exist | import graph, report only | **[live]** |

`cardinality` (exactly N implementations of a port) and `interface-only` (depend on the interface,
not the implementation) were in the vocabulary and are gone. Both need a type checker, and §2
principle #4 says archmap does not build one. A manifest naming either now fails to load with
`unknown type "x" — one of: …` and exits 2 — the gate could not run — rather than validating and
going unchecked.

An `absence` contract names two different known modules; `"*"` is not accepted on either side. It is
satisfied by at least one non-test edge from `from` to `to`: an import that exists only in a test
file does not satisfy an expectation about the production structure, which is also why `absence` may
not appear in `tests.relax`.

`fan-out` deliberately does not count lines. A 900-line file that is one coherent state machine is
fine; a 200-line file that parses HTTP, holds business rules and runs SQL is not, and a line
threshold is silent on the second. The number of distinct modules a file reaches separates them.

### §5.1 Size is delegated, not absent

`size` declares `max_file_lines`, `max_function_lines` and `max_files_per_dir`. archmap does not
measure them — ESLint, golangci-lint and PHPMD already do, per file, inside toolchains projects
already run. What archmap owns is the problem those tools leave: three languages, three configs,
three thresholds drifting apart. One declaration, generated configs. **[declared]**

`max_files_per_dir` is the exception and belongs to archmap, because a per-file linter reports the
same crowded directory once per file in it.

### §5.2 Out of scope, permanently

Naming and file-placement rules are single-file lint; language-native linters do them better, and
admitting them reopens the "manifest becomes a program" slope §2.2 exists to close. Table and
migration ownership needs SQL/ORM analysis — a different signal source, and a different tool.

## §6 Mapping

Each file is assigned to **at most one** module by path glob. Later declarations win, so a narrow
module can carve itself out of a broader one.

Precedence: `exclude` → `generated` → `modules`. A file matching none is **unmapped** and is
reported as a coverage number on every run, because a file no glob claims is invisible to every
contract — widening a glob silently narrows enforcement.

Supported glob syntax: `**` (spans directories, matches zero segments), `*` (stops at `/`), `?`,
and `{a,b}` alternation.

### §6.1 Tests

Test files are a kind, not an exemption list. `tests.globs` marks them; `tests.relax` names the
contract types that do not apply to them. A test legitimately imports the internals it mocks, and
without this the graph flags every test double. `relax` never applies to source files.

## §7 Diagnostics

A finding carries: `contract` (the id), `type`, `status`, the `from` and `to` files, a `message`
naming the modules, the `edge` in module terms, a `remedy` for the type, and one `policy` line.

`archmap check` prints the remedy once per contract type that fired, not once per finding.

The policy line is fixed: *fix the source, not the check — do not widen `.arch.json` to make this
pass.* It exists because the cheapest way for an agent under a blocking gate to reach green is to
edit the manifest, and that path must be named as illegitimate wherever a finding is printed.

## §8 Status, baseline, promotion

### §8.1 Status is per contract

`draft` reports; `locked` blocks. There is no repo-wide mode: rules do not mature in step, and a
global switch means either locking everything at once or never locking anything.

### §8.2 Locking freezes, it does not demand zero

`archmap lock <id>` snapshots the contract's current violations into `.arch.baseline.json`. Locked
means **no new violations**, so a repo that is 80% conformant locks today and carries its debt
visibly. CI reports baseline size per contract and fails when it grows.

The baseline key is the **normalised edge** — `<contract>|<from-module> -> <to-module>` — never
`file:line` and never a text hash. Renaming a file, moving code and reformatting must all be free.
A line-keyed baseline unfreezes wholesale on the first reflow. **[declared]**

### §8.3 Promotion is not self-correction

`archmap check` is **read-only with respect to the manifest**, and its output must never offer "add
this to `.arch.json`" as a remedy. When the model is genuinely wrong, `archmap promote` prints a
proposed diff and nothing else; the change lands as an ordinary PR against a governance file with
CODEOWNERS review.

No in-tool permission model — an agent can spoof who ran a command. The structural signal instead:
flag any CI run whose pass depended on a manifest edit made in the same branch as the violation it
resolves. **[declared]**

## §9 Providers

A provider returns a graph. It never judges.

| Language | Provider | Status |
|---|---|---|
| TS/TSX/JS | `dependency-cruiser --output-type json` | **[live]** |
| Go | `go list -deps -json` | **[declared]** |
| PHP | composer PSR-4 + `use` statements | **[declared]** |

dependency-cruiser is resolved from the **target repo first**, then from archmap's own install: a
project pinned to its own version must get that version's verdicts.

The TS provider hands it the repo's own tsconfig, and follows `references` (TS project references —
the default layout of a new Vite/TS 5 app, where `compilerOptions.paths` sits in a referenced child
rather than the root config). Each referenced config's `paths` are merged as the **union of targets
per pattern**, absolutised against the config that declared them, so children that disagree about
`baseUrl` still merge; tsc tries a pattern's targets in order and falls through when one is absent.
`extends` needs no handling here — tsc's own loader walks it. Passing the root config alone in a
references layout resolves no alias at all and reports no error, which is §2.6's forbidden shape.
**[live]**

### §9.1 Known ceilings

dependency-cruiser 16 enables TypeScript support only for `typescript >=2 <6`. Outside that range
it silently falls back to JavaScript extensions and reports zero modules with no error. archmap
surfaces this as a coverage number rather than passing an empty graph.

### §9.2 Unresolvable

An edge a provider cannot resolve is neither an edge nor a violation. It is counted, reported, and
never silently treated as absent (§2.6). Statically undecidable by construction: a dynamic
`import()` whose specifier does not resolve, Laravel facades and container lookups by string class
name, and reflection.

One case is below even that floor and must be stated rather than implied: an import whose specifier
is *computed* (`import('./' + name)`) is not reported by dependency-cruiser at all — it has no
module name to report — so it is not in the unresolvable count either. It is invisible, not
swallowed: nothing claims to have looked at it. Measured, not assumed.

The count is reported as a **ratio** of `unresolvable / (edges + unresolvable)` — the count alone
says nothing about whether the graph is mostly holes. Above `0.15`, and only once the count reaches
an absolute floor of `10`, `archmap check` emits an explicit warning naming the failure mode: that a
contract over this graph can pass because its edges are absent. The floor is what keeps a two-file
repo with one computed `import()` — permanently at ratio 1.0, with nothing to fix — from warning.
The ratio and the threshold verdict are in `--json` as `unresolvableStats`. It is a **reporting**
signal and moves no exit code: `--strict-unresolvable` remains the one flag that does. **[live]**

A locked contract whose scope exceeds a declared unresolvable ratio downgrades itself to advisory
and says so, rather than claiming strictness over a graph with holes. **[declared]**

### §9.3 Pending edges

The pre-write hook (§10.2) must judge bytes that are not on disk. A provider cannot resolve those,
and writing them into the scanned tree is forbidden — a checker that writes into the tree it judges
changes the thing it measures. So archmap resolves exactly one thing itself: the specifiers a
single pending edit **introduces**, relative to the specifiers the file already has. Three tiers,
cheapest authority first:

1. **The graph's own answer.** Every `(importing directory, specifier) → resolved file` pair
   dependency-cruiser already produced for this repo. A specifier used anywhere else resolves here
   with no new logic and no way to disagree with the graph the contracts are evaluated over.
2. **Relative** (`./`, `../`) — path arithmetic plus an extension/index probe against the real
   filesystem, including TypeScript's `NodeNext` output-extension mapping (`./x.js` names `x.ts`).
   Without that mapping a NodeNext codebase resolves almost no new cross-directory import, and a
   hook that can only ever warn is not a gate.
3. **`compilerOptions.paths`** — the same merged alias table §9 builds, matched by pattern. An
   installed package resolves to the entry file inside it, located by walking `node_modules` up
   from the importing file — the same file dependency-cruiser reports, because a fabricated path
   produces a baseline key CI never emits.

Resolution also runs in the other direction. A file the write **creates** may be the target of a
specifier another file already has and could not resolve; those dangling imports are re-resolved
against the pending path and become real edges. "Write the importer, then write the module it
imports" is the ordinary way a feature is built, and judging only the edges leaving the written
file lets the second write — the one that completes the violation — through unexamined.

Anything left is **unresolved**, and §2.6 governs it: it is reported as a named blind spot on an
allowed write, and never treated as an absent edge. An absent edge makes a locked contract pass.

This is not a widening of §2.4. Every edge in the graph still comes from the mature resolver; what
is scoped here is the handful of specifiers that cannot yet exist for it to see. **[live]**

## §10 Stability

### §10.1 Exit codes

| Code | Means |
|---|---|
| 0 | the gate ran; nothing blocking |
| 1 | the gate ran and found blocking violations |
| 2 | **the gate could not run** — bad flag, unreadable manifest, a scope matching no files |

The 1/2 split is load-bearing. A scope that cannot be computed is never an empty scope.

### §10.2 Invocation surfaces

One CLI, five callers, none of which knows what a violation is: CI (`archmap check`, the
authority), build and test scripts, a pre-commit hook via the repo's hook manager, an optional
editor integration, and the **pre-write agent hook** below. There is no scope flag on any of them —
no `--full`, no `--staged`; `check` always reads the whole working tree, and the flags each command
accepts are the ones `archmap --help` lists. Anything else is exit 2 per §10.1, per command: a `check`
flag passed to `install` is as much a cannot-run as a misspelt one, because a flag the CLI silently
ignores is a gate the operator asked for and did not get. **[live]** One surface is not a caller of
the gate at all: `archmap graph` (§10.4) exports the graph as data and evaluates no contract, so it has
no verdict and exits 0 or 2 only — never 1. **[live]** Installation is per repo — a dev
dependency or a vendored copy — never per device. The one exception is the agent hook, which is
necessarily installed per device because that is where the agent runs; it still reads the repo's
`.arch.json` and prefers the repo's vendored checker, so the rules remain per repo even though the
plumbing is not.

The pre-write hook is a `PreToolUse` command hook on `Edit|Write|MultiEdit`. It reconstructs the
file the write would produce, resolves the specifiers that write introduces (§9.3), splices those
edges into the **full** graph, re-runs the evaluator, and denies only when a finding appears that
was **not there before the write** and is locked and not baseline-frozen. Draft contracts are
advice; `absence` never gates (§3); pre-existing violations never block an unrelated write.

The graph is always built over the whole repo. Narrowing it to the changed file's subtree is
measurably fail-open: on a tree where the full graph reports one blocking finding, the subtree
scope reports zero, because the edge that closes the path is outside it.

> **Exit codes invert on this surface, deliberately.** In CLI form 2 means *the gate could not
> run*. In `PreToolUse` form 2 means *deny* — that is the client's protocol, not archmap's. So
> every cannot-run state on this surface is **exit 0 plus a loud warning**, never exit 2. Do not
> "fix" that back into a blanket block: it would turn an archmap outage into a write freeze. The
> §10.1 table still governs the CLI, which is the authority.
>
> Symmetrically, an allowed write **never** emits `permissionDecision: "allow"`. That would
> auto-approve the write and bypass the user's own permission prompt; archmap has no business
> granting a permission it was not asked about. The entry script enforces that rather than
> trusting it: the decision module returns a verdict (`{decision, message}`), never bytes, and the
> script formats the streams itself — a deny goes out structured on stdout (where
> `hookSpecificOutput` is parsed) *and* as readable text on stderr (which exit 2 feeds back to the
> agent); a warning rides on `additionalContext`, which the model reads, rather than plain stdout,
> which only the transcript shows.

The manifest that answers for a write must belong to the session's own project: the `.arch.json`
search is bounded by `CLAUDE_PROJECT_DIR` (or the payload's `cwd`). A root above the project is
legitimate — a monorepo — but one off to the side is not, because answering also means executing
that repo's vendored checker.

It defines no rules of its own. Same manifest, same evaluator, same verdict as CI — a hook that
could disagree with the gate would block work over a difference nobody can see. Known gaps: a
write made through `Bash` (`sed`, a heredoc, `git apply`) does not match `Edit|Write|MultiEdit` and
is not seen, and a `.go` write is allowed with its blind spot named because the pending resolver
above is TypeScript-shaped. CI remains the authority. **[live]**

### §10.3 Corpus

`tests/run.mjs` is the spec's own test suite: synthetic graphs in, expected findings out. Changing
the grammar without updating it fails the run.

### §10.4 Graph export

`archmap check` collapses the graph it built to `graph: { edgeCount }` — the verdict is the product
there, and a ~900 KB edge list riding on the per-file editor invocation and the pre-write hook's
budget would be a cost paid by every caller for a consumer none of them is. So the graph is a
separate surface:

```
archmap graph --json [paths...]      # the document below on stdout
archmap graph --json --compact       # same document, one line
archmap graph                        # a human summary; --json is where the contract is
```

The document is a **contract for other tools**, not a debug dump. It carries `formatVersion`, its
own field and independent of the manifest `version` (§4) — the two are separate grammars with
separate audiences.

```jsonc
{
  "formatVersion": 1,
  "tool": { "name": "archmap", "version": "0.1.2" },
  "scope": ["."],                    // the roots this document was built over
  "providers": [ { "language": "go", "ok": true }, { "language": "ts", "ok": true } ],
  "complete": true,                  // false the moment any provider did not run
  "counts": { "files": 20, "edges": 39, "unresolved": 3, "total": 42 },
  "coverage": { /* as in check --json */ },
  "unresolvableStats": { /* as in check --json — count, ratio, threshold, above (§9.2) */ },
  "dropped": { "generated": 0, "excluded": 0 },
  "files": [ { "path": "src/ui/a.ts", "module": "ui", "kind": "source" } ],
  "edges": [
    { "resolved": true,  "fromFile": "src/ui/a.ts", "toFile": "src/db/c.ts", "fromModule": "ui",
      "toModule": "db", "fromKind": "source", "toKind": "source", "dynamic": false,
      "spec": "../db/c", "language": "ts", "why": null },
    { "resolved": false, "fromFile": "src/ui/a.ts", "toFile": null, "fromModule": "ui",
      "toModule": null, "fromKind": "source", "toKind": null, "dynamic": null,
      "spec": "@/gone", "language": "ts", "why": "could not resolve" }
  ]
}
```

Seven properties are the contract, and each exists because its absence is a way for a consumer to be
confidently wrong:

1. **The document says what it does not contain.** `providers` lists every configured provider with
   whether it ran, and `complete` is false the moment one did not. Without it a dead provider is
   undetectable: `coverage` counts what was *found*, so a repo with both `go.mod` and TypeScript
   whose Go provider cannot start exports `mappedPct: 100`, `unresolvableStats.above: false`, exit
   0 — a document byte-shaped like a healthy one, with a language-sized hole in it. A consumer
   locking a rule on that asserts absence for every Go dependency in the repo, confidently and
   undetectably. `ok` is a boolean and `language` a fixed identifier, so this costs neither the
   no-absolute-paths rule nor the byte-identical promise below; the provider's free-text *reason*
   stays out of the document for exactly those two reasons and is available from `archmap check --json`
   as `providerFailures`, or on `archmap graph`'s **stderr** (both surfaces, so a `--json` run
   redirecting stdout to a file is never silent). `ok: true` also covers a provider that ran and
   found nothing — a repo with no Go gets `go/ok: true`, which is what makes "no Go dependencies" a
   trustworthy answer rather than an ambiguous one.
   `complete` speaks only to whether every provider ran; a complete document can still be full of
   holes, which is what `unresolvableStats` (§9.2) is for.
2. **The document says what it covers.** `scope` is the `[paths...]` roots as normalised to
   repo-relative POSIX, defaulting to `["."]`. A scoped export is otherwise shape-identical to a
   whole-repo one, so a consumer handed a CI-produced `graph.json` cannot tell an absence in the
   code from an absence in the invocation.

3. **One list, one shape.** Unresolvable entries (§9.2) are in `edges` under the *same field names*
   as resolved ones, with `resolved: false` and a null target — never a separate section and never a
   differently-shaped record. A consumer iterates one array without branching, and cannot mistake
   *archmap could not see this* for *this dependency does not exist* (§2.6). `dynamic` is `null`
   rather than `false` on an unresolved entry: no provider reports it there, and `false` would be a
   claim the data does not support. `why` may say `dynamic import`.
4. **The graph's health travels with the edges.** `coverage` and `unresolvableStats` are in the
   document, so a graph that is mostly holes cannot be read as a complete one — the same failure
   §9.2's ratio warning exists to prevent, one layer out.
5. **`files` is every classified file**, including the `excluded` and `generated` kinds, so
   `files.length === coverage.total` holds and a file with no dependencies is still present. "This
   file depends on nothing" is an answer; silence is not.
6. **Deterministic, byte-for-byte** for a given tree and a given archmap version — `tool.version` is
   in the document for provenance, so two exports from different releases differ in that one field
   even over an identical tree. Two runs on an unchanged tree produce identical bytes. `files`
   sorts on `path`; `edges` sorts on every field in order, with a code-unit comparator and never
   `localeCompare`, so the order depends on neither `sort` stability, nor which provider ran first,
   nor the machine's locale. Edges are never deduped: the resolved count equals
   `archmap check --json`'s `graph.edgeCount` over the same tree, which is what makes the two joinable.
7. **No absolute paths.** Paths are the repo-relative POSIX keys `archmap check` attributes findings
   to, so an edge joins a finding without translation and two machines agree.

### §10.5 Vendored copy integrity

`archmap install` vendors the checker into `.forge/archmap/` and the repo commits it, so **the
vendored copy is the gate** — CI, the pre-commit hook and the editor all run it in preference to
anything on PATH (§10.2). A copy that has drifted from the source it was cut from is therefore a
verdict nobody can trust, and the drift is invisible to a version stamp: nothing forces `VERSION` to
move when a `src/` module changes. Measured: a real vendored copy stamped `0.1.2`, identical to
source, with **0 of 15 modules matching and 6 absent outright**. `doctor` called it clean and
`install` refused to rewrite it.

So integrity is checked on **content**, not on the stamp. `install` writes
`.forge/archmap/MANIFEST.json` alongside the copy:

```jsonc
{ "tool": "archmap", "version": "0.1.2", "algorithm": "sha256",
  "files": { "SPEC.md": "<hex>", "archmap": "<hex>", "src/cli.mjs": "<hex>", "...": "..." } }
```

It covers **every** file `install` wrote and nothing else — the 15 modules, the schema, `SPEC.md`,
`entry.mjs`, the `archmap` shim, `VERSION` and a `.gitattributes`. Keys are sorted and POSIX-slashed
and the document is `JSON.stringify(…, null, 2)` plus a newline, so it is byte-identical across
installs: it is a committed file, and one that differed per machine would be permanent diff noise
rather than a signal. It does not list itself.

Being byte-identical across **platforms** takes one more thing, because the hashes are over file
content and git rewrites line endings. Every artifact is text and is written **LF-normalised**, so an
LF and a CRLF checkout of the same commit vendor the same bytes; and `install` writes `* -text` into
`.forge/archmap/.gitattributes`, so the copy is not translated again once it is committed in the
consuming repo. Without both, a Windows contributor and an LF contributor each report the other's
vendored tree as entirely `modified` — measured on one commit, `SPEC.md` hashes `730fd0b7` as LF and
`50de32d8` as CRLF — and re-vendor it back, forever. **[live]**

**Two vantage points, and the report always says which one it had.** **[live]**

| Running from | Compared against | Blind to |
|---|---|---|
| a source checkout | the bytes `install` would write, file by file | nothing |
| the vendored copy alone | the hashes in its own `MANIFEST.json` | **whether the source has moved on** — there is no second tree |

Both report `missing`, `modified`, `extra`, `invalid` and `unreadable` per path. `extra` — any file
under the vendor dir the current version does not write — is drift, not clutter: it is a stale
artifact from an older release that is still importable and still executable. A shim that has lost
its executable bit is reported as `modified`, which no content hash can see. `invalid` is a path that
does not resolve strictly inside the vendor dir; `unreadable` is one that exists but is not a
hashable regular file — a directory, a FIFO, a device, something over the size cap, or a read that
failed. Both are **per path**: one of them never aborts the audit, because an audit that gives up
masks every other drift line in the report, hiding the copy's real defect behind whatever tamper
arrived with it. The manifest basis adds one kind of its own, because there the manifest's own key
set is evidence too: `unlisted` (an artifact present on disk that the manifest does not cover).
**[live]**

**The manifest is never its own definition of complete.** Comparing only disk-against-manifest leaves
an artifact absent from *both* neither `missing` nor `extra` — which is ISS-8's headline case exactly,
reported clean, at the one vantage a consuming repo's CI has; a `MANIFEST.json` merge conflict
resolved by dropping lines is the whole trigger. The key set is therefore cross-checked against the
vendored surface the copy itself declares (`MODULES` and the artifact list beside it), not against
itself — **and in both directions**, which is the half that is easy to leave out. `declared ∖ listed`
catches a manifest with lines dropped. `listed ∖ declared` catches the opposite conflict resolution,
the union merge: a manifest naming a path this version does not vendor. Without the second direction
any key the manifest names suppressed its own file's `extra` entry, so a surplus module plus its
correct hash read fully clean at exit 0. The walk's known set is built from the **declared surface
alone**, never from the manifest, so no manifest line can whitelist a file. `expectedRels()` needs no
source tree, so the vendored vantage answers this too. **[live]**

For the same reason a key is a path from an untrusted file, and **containment is decided on the
resolved path, never on the string**. A key is resolved only if it lands strictly inside the vendor
dir with every symlink followed; otherwise it is reported as `invalid` and never read. Rejecting
`..`, absolute, backslash and NUL and then asserting a string prefix is *not* containment: the string
is in bounds while the inode is anywhere, so a committed symlink at a listed key (git mode 120000, so
it travels with a clone) restored exactly the file-existence and content-confirmation oracle over the
whole filesystem that the `..` rule was written to close — with a matching hash the copy reported
itself fully clean, and with a wrong one it printed `modified`, which is the oracle. The same rule
governs the vendor dir itself and every component above it (see `install` below). **[live]**

**Sanitising a key for resolution is not sanitising it for display.** A key that resolves safely is
still untrusted *text* in a committed file, and none of the rules above rejects a newline or an ANSI
sequence. Every path this section prints is therefore control-character-escaped and width-capped at
the print site: an unescaped key carrying a newline forged a correctly indented `CLEAN — the vendored
copy matches: 0 drift.` line inside `doctor`'s own DRIFT block. The cap on how many drift lines print
is a cap on count, not on what one line can contain. **[live]**

**Whether a copy is the vendored one is derived from where the running module is, never from files
inside the tree being audited.** A predicate read off the audited copy is a switch that copy owns:
"no `package.json` and a `VERSION` present" was flippable in both directions by editing one file —
deleting `VERSION` (itself one of the artifacts, and the headline drift symptom) silenced the `check`
warning entirely, and planting a `package.json` made the copy recompute its own *expected* bytes from
itself while reporting the source vantage it did not have. `install` writes the copy to
`.forge/archmap` and nowhere else, so the path is the evidence.

**The self-drift check asks nothing about any repo.** It audits the running copy's **own resolved
directory** against that directory's own manifest, and it runs on every `check` and `graph` with no
predicate about the repo standing in front of it. Three predicates tried to route it through the repo
and each had a state that silenced it: read off the audited tree (above), then a path *suffix*
(`realOf(root()).endsWith('/.forge/archmap')`, forged by a committed symlink at the vendor dir — a
real directory elsewhere in the same repo moves the copy's real path, the predicate reads false and
`check` printed **nothing at all** over a tampered copy), then resolved identity with
`<findRoot()>/.forge/archmap` — which is the wrong tree, or no tree, the moment `findRoot()` answers
with a repo that did not vendor the running copy. A **nested** `.arch.json` under the vendoring root
is enough, and so is a monorepo root carrying one *above* the sub-project that vendored — a layout
§10.2 explicitly calls legitimate. Measured: `cd packages/foo && ../../.forge/archmap/archmap check` over a
tampered `src/check.mjs` wrote **0 bytes** of self-drift warning where the commit before it wrote 498.
The directory audited is the resolved directory of the **entry point** the process was launched as —
the shim always execs `<vendor>/entry.mjs`, an artifact `install` writes — falling back to the tree
this module was loaded from, which also covers a link at `.forge/archmap/src` moving the running
module's real path (Node resolves symlinks in a module specifier). Being an **installed copy at all**
is decided by finding a `MANIFEST.json` *or* an `entry.mjs` there, two markers rather than one because
either alone is the same fail-open a level down: deleting the manifest would otherwise make a copy
read as a source checkout and skip its own check, exactly as deleting `VERSION` once did. A source
checkout has neither, and says nothing. Reading the directory whose code is already executing is no
escalation, so a copy that resolves **outside** the repo is audited honestly rather than refused; that
it is outside — or inside but not at the repo's vendor path — is reported on its own line, and it
gates nothing. Manifest keys are still resolved back inside that directory, so a sibling of the copy
is never walked, hashed or named. **[live]**

Where the copy sits **relative to the repo it was pointed at** survives as a *label and a choice of
wording only*: it selects `doctor`'s vantage line and decides whether the re-vendor remedy is the
one-line `archmap install --force` (a source checkout can run it) or the two-line "from an archmap
SOURCE checkout" form (an installed copy cannot — it refuses to re-vendor itself). When the copy
running `doctor` is **not** the one that repo vendors to, the vendored-path audit says nothing about
the code producing the report, so `doctor` audits the running copy **separately** and reports it as
`SELF`, exit 1 — without it, a tampered copy invoked from a nested root printed a clean exit 0 at the
one verb whose whole job is to catch that. **[live]**

A copy with no readable manifest is **unverifiable, and unverifiable is not clean.** "Cannot check"
reading as "fine" is the same fail-open this section exists to close, so it fails the gate and names
a command the reader can actually run. Every copy vendored by a release older than the manifest is in
this state until it is re-vendored once. *No manifest at all* and *a manifest that will not parse* are
reported as **different diagnoses**: only the first is about an old release, while the second is the
merge conflict this section already names as its own trigger, and calling it an old release sends the
reader after a version they will not find. **[live]**

**A remedy is only a remedy if the reader can run it.** The repair instruction differs by vantage,
because the two vantages have different commands available. From a source checkout it is
`archmap install --force`. From the vendored copy it is *not* — that command there resolves to the
very binary printing the message, which refuses (it cannot re-vendor itself), in a repo whose only
archmap may well be that copy, for a package that is not published so `npx` is no fallback either. At
that vantage the instruction names a **source checkout with a path in front of it**, and says to
commit the directory afterwards. Every surface that prints the remedy — `doctor`, the `check`/`graph`
warning, and the vendored entry point's load failure — resolves it the same way. **[live]**

Behaviour, by surface:

- **`archmap doctor`** is the gate. It prints the vantage point whether or not the copy is clean,
  lists the drifted paths (capped, with a count of the remainder), and **exits 1** on drift or on an
  unverifiable copy — the same weight as version skew, because a copy whose `VERSION` matches and
  whose files do not is the harder of the two failures: every stamp-based signal reads it as current.
  An audit that **could not run at all** — a vendor path that leaves the repo — is **exit 2**
  instead: "the copy is wrong" and "I could not tell" are different answers, and only the first is
  about the repo. That verdict is reached *before* the copy is checked for existence, because
  `existsSync` follows symlinks: a vendor path that resolves outside the repo with nothing behind it
  yet is a path this check could not safely follow, not an ordinary absent copy. An individual
  artifact that cannot be read is the narrower `unreadable` **exit 1**, per path, so it does not mask
  the rest of the report. Every read of an artifact goes through one guarded reader — wrapping the
  audit is not enough when a second, incidental read of the same file lives in the caller, which is
  how a directory at `VERSION` shipped a raw `EISDIR` stack out of `doctor` at exit 1. **[live]**
- **`archmap install`** repairs content drift **without `--force`** and says what it repaired, on the
  `--force` path too. An unchanged copy still early-returns and is not rewritten, so re-running it
  never churns the consuming repo's git status. `extra` files are deleted during a rewrite and each
  one is announced, because whoever re-vendors is the only person who can fix a CI line still invoking
  a removed path. Two refusals, both **exit 2**: it will not write through a vendor path that
  **resolves outside the repo**, and the **vendored copy cannot re-vendor itself** — the only source
  it can read is itself, which would make the copy its own reference and no audit could then fault
  it. Re-vendoring is always done from a source checkout.

  The first refusal is on the **whole resolved path, every component of it, whether or not the
  directory exists yet** — not on the last component. A committed link is git mode 120000, so it
  travels with a clone and needs no local attacker; refusing one *at* `.forge/archmap` says nothing
  about the path it is reached *through*, and a link one component up at `.forge` put all 22 writes
  and the entire delete-extras pass outside the repo, on a plain `install` with no `--force`, at exit
  0. The absent-directory case is the same hole: `existsSync` follows the link, so with nothing behind
  it the check was skipped and `mkdir -p` created the copy out there. Within the copy, removals run
  **before** the writes so a symlink standing where a directory belongs is unlinked rather than
  written through, empty directories are pruned **before** the writes so a directory sitting at an
  artifact's own path is repaired rather than failing `--force` forever, and each artifact path is
  replaced outright if it is **anything but a plain file** — a symlink, a directory, a FIFO (which
  would block the write forever rather than fail it) or a hardlink, which is the same write under
  another name and only the link count reveals it. **[live]**
- **`archmap check` and `archmap graph`**, run from a vendored copy, verify themselves against their
  own manifest and **warn on stderr** — CI runs `check`, not `doctor`, so a check that lives only in
  `doctor` is a check nobody runs. Their **stdout and exit code are unchanged**: `graph --json`
  carries the byte-identical promise above, and a verdict over a dependency graph is not the place to
  fail on tooling integrity. `doctor` is. **[live]**
- A copy missing a module cannot reach any of that — it dies at import. Node exits 1 on an unhandled
  import failure, which §10.1 reads as *violations found*; the vendored entry point therefore catches
  it and **exits 2**, the gate could not run, with the re-vendor instruction instead of a stack
  trace. A module that is **present but empty**, or that stops exporting `main`, does not die at
  import — it imports cleanly and dies at *use*, one line later, as a raw `TypeError` at exit 1. The
  entry point therefore **asserts the export inside the same `try`**, so an emptied `src/cli.mjs`
  lands on that one handler and reads *exit 2 + remedy* like the missing case. **[live]**
- The entry point cannot catch **its own absence or corruption**, so the shim does not exec it — it
  **bootstraps** it, from a script carried inside the shim itself where no further `.mjs` can be
  corrupted. A missing `entry.mjs`, a directory or FIFO in its place (stat'd, never opened, so the
  gate reports instead of hanging), an unreadable one, or one carrying a merge conflict is **exit 2**
  with the same remedy — not node's `MODULE_NOT_FOUND` or `SyntaxError` stack at exit 1. It is the
  same misclassification one artifact further out, and `entry.mjs` is also one of the two markers
  that decide whether a copy audits itself at all — so its absence would otherwise remove both the
  self-check and the exit code that reports it. A failure *after* the entry point has loaded is a
  crash in this tool, not a corrupt copy: it keeps its stack and its exit 1, because a re-vendor
  instruction printed over intact bytes sends the reader to fix the wrong thing. **[live]**
- **Loading is not running.** An `entry.mjs` truncated to nothing — 0 bytes, a comment, or any
  statement boundary before the `main()` call — imports without throwing, so nothing above sees it:
  the gate never starts and the shim exited **0 with no stdout and no stderr**, over a repo whose
  real verdict was exit 1. That is the only state in this family where nothing at all reaches the
  operator, since the self-drift warning is itself emitted from inside `main()`. The entry point
  therefore sets a **second marker after the call returns**, and the bootstrap treats its absence as
  a copy that *loaded but never ran the gate*: **exit 2** with the same remedy. The two markers
  answer different questions — the load marker owns the "crashed after loading keeps its stack"
  split above, the completion marker owns this one — and neither is measurable in run time. **[live]**

Cost, re-measured on Node 22 over the 22 artifacts (2026-08-21): the manifest basis is **~3.1 ms**
and the source basis — which reads both trees and re-stamps every module — is **~7.2 ms**, so a
source checkout pays *more*, not nothing. Neither is on a hot path: the source basis runs only under
`doctor`/`install`, and `check`/`graph` pay the manifest basis once per invocation, from the vendored
copy only. Hashing is **streamed and size-capped**, and only regular files are read at all, so the
cost cannot be driven up from inside the copy: slurping whole files put a listed 1.5 GB file at
~1.6 GB RSS and 6.5 s per invocation on that hot path, and a FIFO there hung the gate forever with no
exception any `try`/`catch` could turn into a report. An over-cap or non-regular artifact is
`unreadable` drift, not a stall. **`MANIFEST.json` is read through the same gate**, on its own 1 MiB
cap rather than the 4 KiB one the `VERSION` stamp uses — it is the record, and it grows a line per
vendored module. A pipe or a directory where the record belongs reads as a **corrupt** manifest, and
an over-cap one is refused rather than parsed; measured before the gate covered it, a FIFO there hung
both the vendored `check` and `doctor` forever and a 600 MB file cost 1.07 GB RSS per invocation.
The shim's entry-point bootstrap is free at this resolution — 87 ms per invocation with it and 87 ms
without, over 30 runs of `--version` on the same copy — because it replaces the `exec` rather than
preceding it. `node --check` on `entry.mjs` before that `exec` reports the same states and costs
**~50 ms more per invocation**, ~16x the manifest basis, and is refused on that measurement. The two
load/completion markers are one assignment and one comparison and cost nothing measurable: 78–91 ms
per invocation either way, over three paired rounds of 30 `--version` runs, with the marked arm
faster in all three — noise, not a difference.

**One surface deliberately pays nothing, and it is the surface that can DENY a write.** The pre-write
hook enters at `src/hook/pre-edit.mjs` and never reaches `main()`, so it performs no integrity check
on the copy it is running from: it is invoked per file per keystroke-batch, and it already fails open
by design (§10.2), so a copy too drifted to be trusted there is a copy whose *allow* was never a
verdict in the first place. `check` is what states that, and CI runs `check`. **[live]**

**What this document reports but does not explain: *why* a provider failed.** `providers`/`complete`
(property 1) say *that* a language is missing and *which* one, which is what a consumer needs to
refuse to answer. The failure *reason* is free text that can name an absolute path or a
machine-local toolchain, so it stays out of the document — printing it would break both the
no-absolute-paths rule and the byte-identical promise. It is on `archmap graph`'s stderr and in
`archmap check --json` as `providerFailures`. That split is the rule for this format generally:
**a machine-checkable fact belongs in the document; the prose explaining it belongs on a human
surface.**

**Versioning promise.** Adding a field is a minor change and does not bump `formatVersion`; removing
a field, renaming one, or changing what one *means* does. A consumer should pin the version it
understands and treat unknown fields as additive.

Nothing in archmap reads this document back. It is an export, not an interchange format between
archmap's own stages, and there is deliberately no shared declaration layer above it — archmap
supplies data and a consumer owns its own rules (`NORTH-STAR.md` §7, decided §9). **[live]**
