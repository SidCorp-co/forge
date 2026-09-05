---
paths:
  - "packages/**/*.ts"
  - "packages/**/*.tsx"
  - "packages/**/*.rs"
  - "scripts/**/*.mjs"
---

# Comments & CodeMap (`codemap/1`)

**Rule: if a tool can derive it, don't write it.** No `// Load the config` — the compiler already
says that. No new `TODO`/`FIXME`: fix it in the change you are already making and declare it under
`Extra fixes:`; a defect you genuinely cannot fix here goes in the issue comment, never into the
source and never into a new `draft`. Orientation prose goes in the **module header** (first comment
block, followed by a blank line, ≤20 lines); `/** */` on an `export` is fine (IDE hover docs).

Record the couplings no tool can see, as one-line annotations on line comments (never inside
`/** */`):

| | |
|---|---|
| `// cm:guard <text>` | invariant whoever edits this must obey — **injected into the agent's context before it edits the file** |
| `// cm:edge <kind> -> <repo/path> — <why>` | coupling nothing links. Kinds: `contract` `ordering` `lockstep` `sideeffect` `naming` `protocol` |
| `// cm:flow <flow>/<step> [after:<step>]` | step of a named runtime flow (declare the flow first: `cm new flow`) |
| `// cm:hack ISS-<n> until:<cond> — <text>` | live workaround with an exit condition |
| `// cm:why <text>` | one-line rationale |

**One line means one line, however long.** `cm fmt` does not join a wrapped annotation — measured
2026-08-25, it normalizes 0 of them — and §4 lets an annotation wrap onto exactly ONE following
line, so the second continuation is prose and the tier flags it while the first is adopted in
silence. That first line is a one-line blind spot under every annotation: measured 2026-09-06,
`// Read the pool and return the rows.` directly under a `cm:edge` passes both the whole-tree and
the `--staged` run, and the identical comment two lines away is CM001. 21 lines sit in that slot
across first-party code today and all 21 are genuine continuations — the hole is real and unused,
which is the moment to know about it. Write the whole rule on the single `//` that carries the
`cm:` verb, at 300 characters if that is what it takes. And an annotation makes you the owner of
the comment block it lands in: delete the legacy restatement glued to it, or the file comes back
red on comments you never wrote.

## What earns an annotation

An annotation earns its place when **deleting it would let the next editor make a wrong change**.
Nothing validates the text, so this is the only test. Three things make one carry:

1. **The rule AND the consequence.** `a broken rule check must never freeze a legitimate
   transition` is 61 characters and complete — it says what must hold and what breaks otherwise.
   Short is not the problem; a short rule gets a short line.
2. **The mechanism that makes it non-obvious.** In `dispatch-gates.ts`, "write the identifiers
   LITERALLY" only earns its place because the next sentence says *why*: Drizzle renders a column
   reference inside a raw `sql` template unqualified. Without that, it reads as taste.
3. **Evidence, when the rule came from an incident.** A date, a measured number, the `ISS-`.
   `Measured on forge-beta 2026-08-11: 3 journal entries … have no bookkeeping row` can be
   re-checked, and dates it.

What does not earn one, with live examples from this repo: `cm:why issue lookup`,
`cm:why pendingSkillUpdates`, `cm:why shipped once`. Those are labels, not reasons — the compiler
already names the code. **Under ~30 characters, an annotation is almost always deletable.**

Pick by consumer, not by taste. `cm:guard` is **injected into the agent's context before it edits
the file**; `cm:edge` drives `cm impact`; **`cm:why` has no consumer at all** — nothing reads it,
not even `cm impact`. So anything a future editor must *obey* belongs in `cm:guard`, never
`cm:why`. Filler accumulates in `cm:why` precisely because nothing surfaces it.

## Before you edit a file with declared couplings

`cm impact <path>` (declared half) **plus** LSP references (derivable half) — neither is a
substitute for the other. `cm verify` before pushing; `cm fmt` normalizes. Full verb list: `cm`
with no args, or the `codemap` skill.

## How the gate is scoped

`.forge/codemap/cm` is vendored (codemap 0.16.0) and is the authority — it wins over a `cm` on
PATH, which wins over the plugin's bundled copy. Config: `.forge/codemap.json` (flow vocabulary +
enforcement scope) · `.forge/codemap-baseline.json` (12,454 legacy comments across 965 files frozen
by CONTENT — a comment is flagged only when its text is new, so a reflow or a move is not a
violation).

The `codemap` CI job runs the prose tier **whole-tree**, plus the referential and structural tiers
whole-tree. Both halves are load-bearing. Scoping prose to the PR's changed lines is what an earlier
version of this paragraph described and it is wrong: on a push straight to `main` that diff is empty,
cm prints its success line over zero files, and 15 `CM001` errors landed that way. And a scoped run
attributes a dangling `cm:edge` to the annotated file, dropping it when that file is outside the
diff. Post-baseline prose is at 0, so anything the gate reports is something you just added.

**`CM013` — the one rule that IS scoped, and the one the edit hook never raises.** A change that
altered what a file *does* while paying none of that file's frozen debt is an error: delete or reword
one of its frozen comments (`.forge/codemap/cm sweep <file>` lists them), or convert one to
`cm:guard`/`cm:why`. It needs a base revision, so it holds at the commit (`--staged`) and in CI
(`scripts/check-codemap-drain.mjs`), never mid-keystroke. Reflow, reindent, a formatter run and a
file move all cost nothing. A file whose comments genuinely may not be touched says so once, anywhere
in it: `cm:ignore CM013 — <reason>`.

Bump with `cm install --upgrade`; `.github/workflows/codemap-upgrade.yml` opens that PR weekly, and
`cm doctor` shows any skew. Spec: `.forge/codemap/SPEC.md`.
