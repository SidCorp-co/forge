# codemap/1 — specification

The contract. Every validator message cites a section here.

## §1 Purpose

Carry the **complement of what tools can derive**. LSP derives references; the type system
derives shapes; paths derive modules; git derives history. CodeMap carries only what none of
them can see: cross-language contracts, cross-process flows, and edit-time invariants.

Corollary (§1.1): **if a tool can derive it, you may not write it.** `// Load the config` is not
ugly — it is *invalid*, because the compiler already knows.

## §2 Principles

| # | Principle | Failure mode it kills |
|---|---|---|
| 1 | An annotation kind exists only if a tool consumes it and the payoff lands in the same session | conventions rotting into noise |
| 2 | Derivable ⇒ forbidden (§1.1) | comment spam, duplicating the compiler |
| 3 | Closed vocabulary; unknown value is an error, never a warning | typos, silent graph drift |
| 4 | One obvious place per annotation (§4) | bikeshedding, duplicates |
| 5 | Never load-bearing — delete every annotation and the program is unchanged | comments becoming untested code |
| 6 | The tool owns the format (`cm fmt`), not the author | model output drift breaking the parser |
| 7 | Adoption is incremental; legacy is baselined, not migrated | big-bang rollout abandoned |
| 8 | Every diagnostic has a code, a cause, a fix, and a §pointer | validator gets switched off |

## §3 Vocabulary

Exactly five tags. The set is the size of the set of distinct consumers.

| Tag | Consumer | Purpose |
|---|---|---|
| `cm:flow` | `cm flow` → ordered trace + mermaid | membership in a named runtime flow that spans files/languages/processes |
| `cm:edge` | `cm impact` → blast radius | a coupling no analyzer links |
| `cm:guard` | `PreToolUse` → injected before an edit | invariant or edit rule whoever touches this must know |
| `cm:hack` | `cm verify` → stale-workaround check | temporary workaround with an exit condition |
| `cm:why` | none (read in place) | non-obvious rationale; exists to keep the `cm:guard` channel free of prose |

`cm:invariant` and `cm:gotcha` do **not** exist: their consumer is identical to `cm:guard`'s
(tell whoever touches this), so principle 4 merges them.

`cm:todo` does **not** exist: the issue tracker is the authority on outstanding work, and a
tracked TODO in code is a second, non-authoritative copy of that state. Introducing a new
`TODO`/`FIXME` is `CM010`; file an issue at `draft` instead.

## §4 Syntax

```
<leader> cm:flow  <flow>/<step> [after:<step>] [— <text>]
<leader> cm:edge  <kind> -> <target> [— <text>]
<leader> cm:guard <text>
<leader> cm:hack  ISS-<n> until:<condition> — <text>
<leader> cm:why   <text>
```

- **One line. One annotation.** The machine-parsed part — tag, kind, target, `after:`, `until:` —
  must fit on the annotation's own line; nothing after it is parsed.
- **A wrap is one line, not a paragraph.** The single standalone line comment directly below an
  annotation, under the same leader, is its continuation: exempt from prose enforcement, and carried
  on the annotation as `wrap` rather than merged into its `text` (so `canonical` and `cm fmt` never
  rewrite across lines). A second such line is prose again — and, sharing the block, is sited (§8),
  so it cannot be frozen. Without this, every wrapped annotation in the wild is a hidden `CM001` that
  the baseline freezes forever, which is how an annotation layer ends up *adding* comments.
  A line below a cm: comment is its continuation whether or not the annotation parsed — otherwise a
  malformed annotation is reported twice, the second time telling the author to delete a legal wrap.
  A line the baseline has FROZEN is never a continuation: it was prose when the baseline was taken, so
  the annotation's author did not write it. Adopting one fuses a stranger's sentence into an injected
  guard, which is worse than the comment it replaces — the reader is told to honour it. Such a line falls
  through to prose enforcement, where siting (§8) reports it, so it is refused visibly rather than
  silently.
- **A query returns the whole sentence.** `cm impact`, `cm flow` and `cm ls` render `text` and `wrap`
  joined, and the `PreToolUse` hook consumes that JSON. Handing an agent the first half of an
  invariant is worse than handing it nothing: authors write the rule first and the consequence
  second, so the missing half is the actionable one.
- **Line comments only.** Never inside a block or doc comment (`/* */`, `/** */`, `///`, `//!`,
  `{{-- --}}`) — that is `CM003`. Rationale: block/doc comments are parsed by TSDoc, PHPStan,
  Psalm, and rustdoc; staying out of them means no other toolchain ever sees a `cm:` line.
- `<leader>` is the language's line-comment leader: `//`, `#`, or `--` (§6).
- `<flow>/<step>` is the step's durable id. Ordering comes from `after:`, never from numbers, so
  inserting a step never renumbers the flow.
- `<kind>` ∈ `contract | ordering | lockstep | sideeffect | naming | protocol` (§5).
- `<target>` is a repo-relative path, optionally `path#symbol`. Absolute paths, URLs and
  source-relative paths (`../`, `./`) are `CM005` — rejected at the keystroke, not later in CI. A
  `../` target that resolves is rewritten by `cm fmt`; `cm verify --fix` never rewrites a target,
  because a target is content and the edit hook runs `--fix`.
  The `#symbol` half is checked too: it must appear in the target file, or `CM106` (§7).
- **`external:<name>/<path>`** targets a system that is **not in the tree** — a migration's original
  codebase, a service in another repo. `<name>` must be declared in the registry (§8) or it is
  `CM107`, and that name is *all* that is verified: nothing here can see the path inside it. This is
  the deliberate trade — `cm:edge`'s promise that a target resolves is kept for in-tree targets by
  making the out-of-tree case a different shape, rather than by weakening `CM102` for everyone. A
  migration repo's commonest cross-system contract is otherwise unexpressible, and 354 such comments
  in one measured repo were carrying it as prose.
- `->` is ASCII (it sits in the machine-parsed position). `—` separates prose; `-` and `--` are
  accepted on input and normalized to `—` by `cm fmt`.
- Prefix is `cm:` — deliberately **not** `@`-prefixed. The `@`-in-comment namespace belongs to
  compilers and doc parsers (`@ts-expect-error`, `@param`, `@flow` is Flow's own file pragma).

Single recognizer:

```
^\s*(//|#|--)\s*cm:(flow|edge|guard|hack|why)\b
```

Because the recognizer keys on a line *starting* with `cm:`, prose that happens to wrap onto a line
beginning with `cm:` parses as a malformed annotation. Reword such a line; do not escape it.

### §4.1 The module header

Orientation prose about a whole file is not derivable, and every ecosystem gives it a home (Go's
package doc, Rust's `//!`, Python's module docstring). TypeScript has no idiom, which is exactly why
agents scatter narration through function bodies instead. So there is **one** legal place for it:

The **module header** is the first contiguous comment run of the file — after an optional shebang and
an optional directive prologue — **followed by a blank line**, before any code. It is exempt from
`CM001`, up to `enforce.headerMaxLines` (default 20) lines; beyond that it is `CM011`.

The **directive prologue** is `"use client"`, `"use server"` or `"use strict"` in TS/JS: constructs
the language itself requires above everything else, so a header cannot get above them. Measured on a
Next.js App Router codebase, treating them as code cost 23 legitimate headers. The vocabulary is
closed (principle 3) — a general "leading string literal" rule would swallow an expression statement.

The trailing blank line is the whole test. A comment glued to the first statement is narration, not
a header, and is still `CM001` — but when that run sits at the top of the file it is one blank line
away from being legal, so the diagnostic's fix line says so instead of only offering deletion.

Multi-line rationale belongs in the header. One-line rationale at a call site belongs in `cm:why`.

### §4.2 Doc comments

A `/** … */` block is documentation **by form** — the IDE surfaces it on hover, a consumer with an
immediate payoff — so it is exempt wherever it appears. A `/* … */` block is not a doc comment and is
prose. Narration inside a function body, the spam this framework exists to kill, is always a line
comment.

The first cut of this rule exempted doc blocks only directly above an `export`, and it flagged JSDoc
on interface members within the hour. Deciding which declarations *deserve* documentation is not the
framework's business; distinguishing documentation from narration is.

Go is the exception, via `docPolicy: required-on-exported`: it has no block-doc form, so the same
distinction has to be made positionally on `//` runs.

## §5 Edge kinds

| Kind | Means | Example |
|---|---|---|
| `contract` | two sides must agree on a value/format neither type-checks | Rust emits `[USAGE_LIMIT]`, a TS regex must match it |
| `ordering` | A must happen before B, and nothing enforces it | deploy core before runner |
| `lockstep` | these files must change in the same commit | three desktop version files |
| `sideeffect` | effect happens outside this language | DB trigger, cron, queue worker |
| `naming` | coupling is a *name*, not a reference | config map keys ↔ skill names ↔ enum values |
| `protocol` | call semantics not visible in the signature | PATCH replaces the whole map, not a deep merge |

## §6 Language profiles

`docPolicy` decides what happens to ordinary doc comments; it is what makes the framework
survive contact with ecosystems whose convention is the opposite of "few comments".

| Language | Leaders | docPolicy | Notes |
|---|---|---|---|
| TS/JS/TSX | `//` | `banned` for `//` and `/* */`; `/** */` doc blocks allowed (§4.2) | pragma allowlist covers `@ts-*`, eslint/biome, bundler hints |
| Go | `//` | **`required-on-exported`** | exempt directly above: the package clause, an EXPORTED top-level declaration, a `type`/`const`/`var` group opener, and a **capitalised member of an exported `struct`/`interface`/group** — godoc renders a field's and a method's doc exactly as a package-level one |
| PHP | `//` `#` | `allowed` | PHPStan/Psalm/Laravel IDE-helper docblocks are load-bearing; `_ide_helper*` and `vendor/` are excluded outright |
| Python | `#` | `allowed` | docstrings are strings, not comments, so they are out of scope by construction |
| Rust | `//` | `allowed` for `///`/`//!` | `// SAFETY:` is exempt (clippy requires it) |
| SQL | `--` | `allowed`, enforcement off | annotations still parsed, so `sideeffect` edges can live next to a trigger |
| Shell/YAML/TOML | `#` | `allowed`, enforcement off | annotations parsed for CI/compose edges |

A member is judged by the nearest line at column ZERO above it: `type X struct`/`interface`, or a
`type`/`const`/`var` group opener, means the capitalised name below it is a documented member. `func`
there means the comment sits in a body, where narration is narration — capitalisation alone cannot tell
`Do() error` in an interface from a same-package `DoThing()` call, and the in-body case is what the
policy exists to catch. `func (` is not a group opener: it is a method receiver, and admitting it would
exempt every unexported method.

A godoc-shaped comment above an **unexported** declaration stays flagged. revive's `exported` rule
covers exported names only, so documenting an unexported one is a choice its author makes rather than a
convention the ecosystem imposes — and `docPolicy: required-on-exported` exists to exempt the second,
not the first. This is the largest bucket left in a Go repo after the member rule (4 347 lines measured);
a repo that wants those spared should set `docPolicy: allowed` for Go rather than widen the exemption.

A file whose first lines mark it generated (`Code generated ... DO NOT EDIT`, `@generated`,
drizzle/`_ide_helper` markers) is skipped entirely.

The scanner keeps comment leaders inside string literals from being read as comments, and does the
same for a **bare URL** outside one — the `//` in JSX text (`<a>https://x.dev</a>`) or a `#fragment`
in a YAML scalar. The scheme vocabulary is closed (principle 3): an unlisted scheme costs a false
`CM001` its author can silence, whereas a general `<ident>:` rule reads `{ key://cm:guard … }` as a
URL and drops the annotation with no diagnostic — and a missed annotation is the one failure this
scanner does not permit itself.

## §7 Diagnostics

Tier decides where it runs: **grammar** in `PostToolUse` (blocking), **referential** and
**structural** in CI, **advisory** only when asked for (§7.1). Only the grammar tier may block an edit:
the others are judged against the whole graph, and a scoped run cannot tell "broken" from "the other end
is out of scope". For the same reason the graph is always built from the whole tree even when reporting
is scoped — a one-file graph made a legal two-step flow report `CM103`/`CM201` against itself.

| Code | Tier | Meaning |
|---|---|---|
| `CM001` | grammar | prose comment where `docPolicy: banned` — delete it, or convert to `cm:why`/`cm:guard` if it records something non-derivable |
| `CM002` | grammar | unknown `cm:` tag (§3) |
| `CM003` | grammar | `cm:` annotation inside a block/doc comment (§4) |
| `CM004` | grammar | `cm:edge` missing or unknown `<kind>` (§5) |
| `CM005` | grammar | `cm:edge` target missing, absolute, or a URL (§4). Also when `->` is used inside what should have been a `cm:why` |
| `CM006` | grammar | `cm:flow` needs `<flow>/<step>` (§4) |
| `CM007` | grammar | `cm:hack` needs `ISS-<n>` and `until:<condition>` (§4) |
| `CM008` | grammar | annotation body empty |
| `CM009` | grammar | non-normalized form — `cm fmt` fixes it |
| `CM010` | grammar | new `TODO`/`FIXME` introduced (§3). Marker-shaped only — at the start of a comment, or followed by `:`/`(` — so identifiers like `TC-XXX` are not flagged |
| `CM011` | grammar | module header longer than `headerMaxLines` (§4.1) |
| `CM012` | grammar | `cm:edge` kind and target parse, but the rationale follows with no ` — ` (§4). Split from `CM005`, which blamed the `->` that was already correct |
| `CM013` | grammar | the file was edited and paid none of its frozen prose debt (§8). The one grammar code the edit hook does not raise — it needs a base revision, so it holds at the commit and the PR |
| `CM101` | referential | flow not declared in the registry (§8) |
| `CM102` | referential | `cm:edge` target does not exist |
| `CM103` | referential | `after:` names a step that does not exist |
| `CM105` | referential | duplicate `<flow>/<step>` id |
| `CM106` | referential | `cm:edge` `#symbol` is not in the target file, or the target is a directory (§4). A word-boundary match on the anchor's first dot-segment — not resolution, which stays LSP's job |
| `CM107` | referential | `cm:edge` names an `external:` that the registry does not declare (§8) |
| `CM302` | advisory | an annotation's text is prose the baseline already froze — a tag worn by legacy narration (§7.1) |
| `CM301` | advisory | a `contract`/`lockstep` edge with a `#symbol` where NEITHER file names the other — the coupling may be intention rather than code (§7.1) |
| `CM201` | structural | flow has a single step — either it is not a flow, or steps are missing |
| `CM202` | structural | `after:` chain is cyclic or the flow has several roots |
| `CM104` | reserved | stale `cm:hack` (issue closed) — requires the Forge integration, tier 3 |

### §7.1 The advisory tier

Both codes here ask a question the other tiers cannot: not *is this well-formed* or *does this resolve*,
but *does this annotation carry what it claims to*. `CM302` exists because the rigour was one-sided —
prose was judged on form and position with twelve codes, while an annotation's text was judged only on
being non-empty, so under a blocking hook a six-character prefix was the cheapest way to clear `CM001`.
It is content-blind: it asks whether those exact words were already frozen as legacy, which the baseline
already knows.

`CM102` answers *does the target exist*; `CM106`, *is the symbol still there*. Neither answers *is the
coupling real* — a function can declare `cm:edge contract -> other.ts` that `other.ts` has never called,
and the annotation then documents an intention rather than the code.

That question must stay **weak**, because several kinds are deliberately reference-free: `naming` IS a
string, `sideeffect` happens in SQL or a cron, and a `contract` across a process boundary is
HTTP-mediated. So the tier is warning-only, never gating (it cannot change the exit code), and narrow:
only `contract` and `lockstep`, only with a `#symbol`, only when neither file names the other.

Evidence comes in two tiers, strongest first. When the repo has archmap (a sibling tool, see
NORTH-STAR §8) vendored at `.forge/archmap`, `graph.mjs` reads its exported import graph (`archmap
graph --json`) and asks whether the two files are actually wired together at all — a real edge, not a
guess. Everywhere else the fallback is a basename match, biased toward silence — a generic stem
matches easily and the check says nothing.

It stays **off by default** regardless of archmap: `enforce.advisory` in the registry, or an explicit
`--tier advisory`, is still the only thing that turns it on. Archmap's presence never flips that
default — `archmap graph` is a full-repo static analysis (measured ~15s on a 1600+ file repo), and
`cm verify` with no `--tier` is exactly what the `PostToolUse` hook runs on every single-file edit
(§4.1); making that call on every edit in an archmap-vendored repo turns each one into a multi-second
stall. A repo opts in once its own FP rate is measured — the same registry flag as before, now backed
by real evidence instead of a guess when archmap happens to be vendored too.

The basename-only measurement, kept for scale: two production repos (2 234 and 3 277 files, 204 edges,
69 of them anchored) reported **40** `CM301` before two structural corrections and **5** after; of
those 5, **one** was actionable — an edge whose anchor is a slug string, so its kind should be `naming`
(§5) rather than `contract`. The other four are the shape the check cannot see: two sides that must
implement the SAME RULE with nothing linking them (a frontend predicate and a backend selector; the
same SQL ordering in two loaders). For those, the absence of a reference is not drift — it is the
normal state of the most valuable edge in the repo, which inverts the check's premise. Re-measured
against those same 5 with archmap's real graph: **0** were suppressed — archmap independently confirms
none of the five has an import edge either, which is what the manual analysis above already found by
hand. The two structural corrections were bugs rather than thresholds, and both are cases where
evidence *cannot* exist:

- a pair of files in **different languages** (26 of 36 hits in one repo) — Go cannot import a `.ts` file
- **Go**, which names the imported package DIRECTORY and never the file (10 of 10 same-language hits
  there), so a filename-only test warned on every correctly wired Go edge

Measure before flipping `enforce.advisory` on for a repo with no archmap, and expect the answer to
depend on how that repo's edges are shaped:

```bash
cm verify --tier advisory --json | jq '[.diags[] | select(.code=="CM301")] | length'
```

## §8 Registry

`.forge/codemap.json`, JSON so it parses with zero dependencies and validates against
`schema/codemap.schema.json`.

```json
{
  "specVersion": "codemap/1",
  "flows": [{ "name": "job-dispatch", "description": "issue → dispatched job" }],
  "externals": [{ "name": "laravel-app", "description": "the PHP original this service replaces" }],
  "enforce": { "grammar": true, "drain": true, "include": ["**"], "exclude": ["**/*.test.ts"] },
  "languages": { "sql": { "enforce": false } }
}
```

Steps are **not** declared — they are derived from the code (§1.1). The registry only closes the
vocabulary of flow *names* and of `external` *names*. An external's path is never declared and never
checked; closing the name is what keeps a typo from forking the graph, which is the same job `CM101`
does for flows.

### §8.1 Where the checker lives

A repo's CI gates on the checker it **committed**, so a newer plugin reporting green says nothing about
that gate. `cm verify` warns on the skew, `cm doctor` reports it in one place, and `cm install --upgrade`
moves it forward — refusing a downgrade unless forced. Without this the pin meant to stop drift becomes
the mechanism by which a repo cannot receive a fix.

The registry is the repo's contract, so the repo must be able to check it. `cm install` vendors the CLI
into `.forge/codemap/` — a `cm` shim, `cm.mjs`, `lib/`, `SPEC.md` and a `VERSION` stamp — and that
directory is committed. From then on:

| Enforcement point | Runs | Needs the plugin |
|---|---|---|
| CI | `.forge/codemap/cm verify --since <base>` | no |
| pre-commit | `.forge/codemap/cm verify --staged` (`cm install --git-hook`) | no |
| the agent, mid-edit | plugin hooks, which **prefer** `.forge/codemap/cm.mjs` | yes, and only for this |

The plugin is therefore the guide and the edit-time UX, never the authority. A repo pinned to an older
vendored copy keeps that copy's verdicts, and a contributor without the plugin is held to exactly what
CI holds them to — the asymmetry that used to leave one contributor unconstrained and hand the next one
their violations.

`.forge/codemap/**` is excluded from scanning unconditionally, not via the registry's `exclude` list: a
project onboarded by an older `cm init` carries that list frozen in its file.

**No registry ⇒ prose enforcement is off.** The `cm verify` CLI still reports `CM001`/`CM010` so an
operator can size the problem before onboarding, but the edit hook blocks only on malformed
annotations (`CM002`–`CM008`). Prose enforcement begins at `cm init`, which also writes the baseline.

That asymmetry is deliberate: the plugin can be installed once, machine-wide, across every repo, and
no un-onboarded legacy tree is ever blocked. Onboarding is a per-repo decision, not a side effect of
installing.

`.forge/codemap-baseline.json` freezes pre-existing prose **by content**: per file, the set of
hashes of the normalized comment texts, plus — per `b:`-prefixed block key in that set — the number
of line keys the block froze, read by CM013 (§8, below) and otherwise inert. A violation is
suppressed when its text is already in that set, so legacy code is frozen rather than migrated
(principle 7). Regenerate with `cm baseline`.

The first design counted comments per file and failed on contact: adding three lines to a file with
eighty frozen comments surfaced all eighty, because a count cannot say *which* comment is new. The
content hash can. It is also line-independent, so reformatting, moving code, and deleting legacy
comments are all free.

A pre-0.2 count-format baseline is detected, ignored, and reported — never silently trusted. While it is
unreadable, prose is **not** enforced at all: nothing can tell new prose from legacy, so blocking an
author for a comment they did not write is the wrong half of the trade. The edit hook says so instead.

A frozen key is dropped only when its text is **gone from the file**. Sited prose (below) is still in the
file, so it stays frozen: it is reported anyway, and the annotation that sited it may be removed later.

The baseline has two paths that reduce it, and they are the same question asked at two scales: did
the person who just worked here leave the noise behind? Without either, legacy prose is spared
forever, annotations only accrete, and a repo ends with more comments than before onboarding.

**The site: sited prose is never frozen.** A `CM001`/`CM010` violation sharing a comment block with a
`cm:` annotation is reported regardless of the baseline. Contiguous standalone comment lines form one
block; a trailing comment on a code line is not part of one. `CM011` is excluded — it measures a
header's length, not one comment's text, so no site can own it. The rule is narrow on purpose — an
author who annotates a site has just read it, so the noise there is theirs; prose they never touched
stays frozen.

**The file: `CM013`.** Siting fires only when an author reaches for a tag, so a file with frozen debt
could be refactored, extended and rewritten for years with its frozen count never moving. `CM013`
asks what siting cannot: this change altered what the file *does* and paid none of that file's frozen
debt — why is the count still the same? Deleting or rewording one comment satisfies it.

It is raised only on a run that has a base revision (`--since <ref>`, or `--staged` ⇒ `HEAD`), because
"edited" has no meaning without one. A whole-tree or single-path `cm verify` never raises it, and
neither does the edit hook: the unit is a change, not a keystroke, and a rule that stopped an author
mid-edit to demand unrelated cleanup is the mistake the hook's own `--changed-lines` scoping already
records paying once.

Reflow, rewrap, reindent and a repo-wide formatter run are free — not by exemption, but because the
rule compares the two revisions' *code* with comments stripped and whitespace normalized, so only an
edit that changed what the file does can trigger it. A file move is free for the same structural
reason the rest of §8 is: the new path has no baseline entry, so there is no debt there to drain.
`enforce.drain: false` turns it off; `cm:ignore CM013 — <reason>` does so for one file, and is read
from anywhere in that file because the anchor line moves as the prose above it does.

A rewrap that touches every line of a frozen block is not free the way a whole-file reflow is: the
block's own key is reflow-invariant (it hashes the block's full text, whitespace-normalized) and
survives, but each line's own key changes, so the baseline also records how many line keys the block
froze. A rewrapped block is charged that count, not a flat one, so merging or re-splitting a frozen
block's lines cannot pay CM013 on its own. A baseline written before this was tracked has no count
for a block it already froze, and credits it 1 (today's behaviour) until it is re-frozen with
`cm baseline`.

`cm sweep` lists what the baseline is hiding, and `cm sweep --prune-baseline` drops keys matching
nothing, so paid-off debt stops being counted.

## §9 Stability

### §9.1 Exit codes

| Code | Means |
|---|---|
| 0 | the gate ran; nothing but structural warnings |
| 1 | the gate ran and found violations |
| 2 | **the gate could not run** — bad flag, unknown `--tier`, unresolvable `--since`, path that matches nothing |

The 1/2 split is load-bearing. Every fail-open bug this tool has shipped had the same shape: a broken
invocation that produced an empty scope and a green summary — a mistyped `--tier` value silently dropping
every diagnostic, an unresolvable ref exiting 1 from a raw stack trace so CI could not tell it from a lint
failure, a mistyped path scanning zero files. A scope that cannot be computed is never an empty scope.

A diagnostic must also be *fixable by its own fix line*. `CM009`'s fix is `cm fmt`, so `cm fmt` may never
report a rewrite it did not perform (it once could not rewrite a CRLF line at all, and said it had).

- `specVersion` is checked by every command; a tool older than the registry refuses to run.
- A grammar change ships with a codemod (`cm migrate --to <n>`). Annotations are structured
  single lines, which is what makes codemods cheap.
- `tests/fixtures/` is the golden corpus: source snippet → expected graph and diagnostics.
  Changing the grammar without updating fixtures fails CI. This is the spec's own test suite.
- Deprecation: a removed form warns for one minor with a codemod available before it errors.
- Escape hatch: `cm:ignore <CODE> — <reason>` on the line above. The code and the reason are both
  mandatory; a bare ignore is itself an error.

## §10 Metrics (ISS-3)

ISS-3's own framing of the number that matters: how many times a `cm:` annotation blocked a real
mistake before it shipped, not how many files/annotations/tests exist (that count is distinct from
NORTH-STAR.md §5's external-adoption north star; §5 item 5 points here). Scale metrics rising while
that number sits at zero looks exactly like success — the trap that killed the repos before this
one. `cm metrics` is the counter, local by default.

**Where it lives.** `.forge/.codemap-metrics/` — an events log (`events.jsonl`, append-only) and a
pending-block state file (`pending.json`). Never inside `.forge/codemap/` (that tree is vendored and
committed by `cm install`); never touched by any `cm install`/`cm init` file list. Nothing here is
ever written to the repo's `.gitignore` automatically — that would be editing a file this tool did
not create, which no other command in this codebase does either.

**Shape, not content.** An installed repo may hold real customer data, so every event carries only:
a timestamp, an event kind, a diagnostic `tier`, a list of `codes`, and (for `block`/`held`/
`circumvented`) the repo-relative `file` path. Never a diagnostic's `message`/`fix` text, never the
comment that triggered it. `annotation-snapshot` and `registry-snapshot` events carry counts and
booleans only — never an annotation's own text, never an author's name in the shape that could ever
be sent (only the count of distinct authors).

**Held vs circumvented — counted separately, never merged into one "resolved" bucket.** The
PostToolUse hook already decides what blocks (`scripts/lib/blocking.mjs`, the same predicate on both
sides of this line so the two can never disagree); every block appends a `block` event and opens a
pending entry keyed by `(file, code, line)` — line-level, not code-level, because a repo can carry
more than one instance of the same code in one file (frozen legacy prose is the common case), and a
coarser key let a genuine fix of one instance hide forever behind an unrelated, never-blocked other
one (ISS-3 review round 1). The NEXT time that exact `(code, line)` is recomputed — the next hook
invocation on the file, or a `cm metrics reconcile` sweep of the whole pending set:

- it is no longer present → **held**, decided from presence ALONE, regardless of whether a commit
  landed on the file since. The author fixed it; committing that fix is the ordinary, desired flow
  and must never be misread as evasion just because a commit happened to follow the block.
- it is STILL present AND a commit landed on the file since the block fired (checked via
  `git log --since`, with a 1s buffer past the block's timestamp for git's own second-granularity) →
  **circumvented**. The flagged content shipped once already, still unfixed — a client-side hook with
  no server-side gate is exactly the failure mode this exists to catch.
- still present, no commit since → still pending, no event fires. A file the checker itself cannot
  verify is left pending too, never guessed at either way.

Held is checked before circumvented, never the other way round: checking "did a commit land" first
would read the ordinary fix-then-commit sequence as evasion on every single genuine fix.

`cm metrics reconcile` exists because a file committed and never touched through the hook again (the
common shape of "routed around it entirely") would otherwise never reconcile — the weekly upgrade bot
NORTH-STAR §5 already wants can run it.

**Local sink, sending is opt-in.** `cm metrics show [--json]` reads the local log only; nothing it
does can reach the network. `cm metrics send --endpoint <url> [--yes]` builds the exact same payload
`show --json` prints — one function, `buildPayload`, so there is no separate "preview" that could
drift from what actually goes out — and only performs the POST when BOTH `--endpoint` and `--yes` are
given. Either one missing prints the payload and stops. There is no default endpoint.
