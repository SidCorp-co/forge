# archmap/1 — specification

The contract. Every finding cites a section here.

Status markers: **[live]** implemented and covered by `tests/run.mjs`; **[declared]** in the
vocabulary and validated, but no evaluator yet — a manifest may name it and `arch check` reports it
as skipped rather than passing it silently.

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

**[live]** divergence. **[declared]** absence — it is excluded from the gate on purpose: in a check
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

Eight types, closed.

| Type | Says | Needs | Status |
|---|---|---|---|
| `layers` | ordered tiers; a module may depend on later entries, never earlier | import graph | **[live]** |
| `forbidden` | `from` must not depend on `to`; `to: "*"` means nothing outside itself | import graph | **[live]** |
| `independence` | these modules must not depend on each other, transitively | import graph | **[live]** |
| `boundary` | a module's public surface; cross-module edges must land on it | import graph | **[live]** |
| `fan-out` | a file or module may reach at most N distinct modules | import graph | **[live]** |
| `cardinality` | exactly N implementations of a port | type checker | **[declared]** |
| `interface-only` | depend on the interface, not the implementation | type checker | **[declared]** |
| `absence` | this dependency should exist | import graph, report only | **[declared]** |

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

`arch check` prints the remedy once per contract type that fired, not once per finding.

The policy line is fixed: *fix the source, not the check — do not widen `.arch.json` to make this
pass.* It exists because the cheapest way for an agent under a blocking gate to reach green is to
edit the manifest, and that path must be named as illegitimate wherever a finding is printed.

## §8 Status, baseline, promotion

### §8.1 Status is per contract

`draft` reports; `locked` blocks. There is no repo-wide mode: rules do not mature in step, and a
global switch means either locking everything at once or never locking anything.

### §8.2 Locking freezes, it does not demand zero

`arch lock <id>` snapshots the contract's current violations into `.arch.baseline.json`. Locked
means **no new violations**, so a repo that is 80% conformant locks today and carries its debt
visibly. CI reports baseline size per contract and fails when it grows.

The baseline key is the **normalised edge** — `<contract>|<from-module> -> <to-module>` — never
`file:line` and never a text hash. Renaming a file, moving code and reformatting must all be free.
A line-keyed baseline unfreezes wholesale on the first reflow. **[declared]**

### §8.3 Promotion is not self-correction

`arch check` is **read-only with respect to the manifest**, and its output must never offer "add
this to `.arch.json`" as a remedy. When the model is genuinely wrong, `arch promote` prints a
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

### §9.1 Known ceilings

dependency-cruiser 16 enables TypeScript support only for `typescript >=2 <6`. Outside that range
it silently falls back to JavaScript extensions and reports zero modules with no error. archmap
surfaces this as a coverage number rather than passing an empty graph.

### §9.2 Unresolvable

An edge a provider cannot resolve is neither an edge nor a violation. It is counted, reported, and
never silently treated as absent (§2.6). Statically undecidable by construction: computed dynamic
`import()`, Laravel facades and container lookups by string class name, and reflection.

A locked contract whose scope exceeds a declared unresolvable ratio downgrades itself to advisory
and says so, rather than claiming strictness over a graph with holes. **[declared]**

## §10 Stability

### §10.1 Exit codes

| Code | Means |
|---|---|
| 0 | the gate ran; nothing blocking |
| 1 | the gate ran and found blocking violations |
| 2 | **the gate could not run** — bad flag, unreadable manifest, a scope matching no files |

The 1/2 split is load-bearing. A scope that cannot be computed is never an empty scope.

### §10.2 Invocation surfaces

One CLI, four callers, none of which knows what a violation is: CI (`arch check --full`, the
authority), build and test scripts, a pre-commit hook via the repo's hook manager, and an optional
editor or agent integration. Installation is per repo — a dev dependency or a vendored copy — never
per device.

### §10.3 Corpus

`tests/run.mjs` is the spec's own test suite: synthetic graphs in, expected findings out. Changing
the grammar without updating it fails the run.
