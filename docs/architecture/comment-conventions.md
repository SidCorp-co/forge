# What a comment in this repo may claim

**Written 2026-09-16 against `33eabd7e`, as part of ISS-1049.** This file is the record of a
decision: which annotation kinds this repository carries, why the rest were removed, and what was
knowingly given up with them.

## The rule

**A comment beside code explains that code. It does not make a claim about anything else.**

A sentence that asserts something about another file, another repository, a database row, a past
incident or a rule the reader must obey is a claim, and a claim nobody checks rots in silence. The
marker on the front of it changes nothing: `// cm:guard the caller must …` and
`// NOTE: the caller must …` are the same defect wearing different clothes, which is why nothing
here was "reflowed into an ordinary comment".

Where a claim is worth keeping, it goes somewhere that can be searched, dated and corrected:

| The claim is about | It lives in |
|---|---|
| a measured lesson, a cost, a falsifying experiment | a `knowledge_entries` row — `forge knowledge search` |
| a coupling with `github.com/SidCorp-co/forge-plugin` | [`forge-plugin-coupling.md`](forge-plugin-coupling.md) |
| what a gate is, and what it was born from | [`../../scripts/README.md`](../../scripts/README.md) |
| what shipped | `CHANGELOG.md` |
| why a change was made | the tracker issue, which the commit names |

## The annotations that survive

Three kinds are still carried, and each is carried because something reads it:

- **`cm:flow`** — 7 of them. `scripts/check-flow-coverage.mjs` reads every one and asserts the
  integration suite enters the function its step sits on. A `cm:flow` that names a line nothing
  runs fails the `behaviour` axis.
- **`cm:hack`** — 7 of them. Each names an issue and an `until:` condition, and a condition is
  checkable by whoever reads it. That is the shape `CLAUDE.md` demands under *A trade-off is
  priced or it is not taken*; dropping the marker would turn a priced amnesty into an unnoticed
  one.
- **`cm:ignore`** — 37 of them. A directive to the `cm` tool, not a claim about the code.

## What was removed, and the count

ISS-1049 removed **8,861 annotations across 1,672 files** — 6,772 `cm:guard`, 1,297 `cm:why` and
792 `cm:edge` — from `packages/core/src`, `packages/core/tests`, `packages/runner/crates`,
`packages/web-v2/src`, `packages/contracts/src`, `packages/observability/src` and `scripts/`.
`.forge/archmap/` is vendored and was left alone; so were the annotations inside landed migration
files under `packages/core/drizzle/`, which are a record rather than a briefing.

The measurement that decided it: of 1,784 distinct identifier-shaped names cited inside that prose,
**94 (5.3%) appeared on no non-comment line anywhere in the repository**. `PIPELINE_STEPS`,
`claimRunnerSlot`, `alarmChurningIssues` and `REOPEN_CAP` survived only in `CHANGELOG.md` and in
the comments citing them; `STATUS_TO_JOB_TYPE` survived nowhere but the annotations. Nothing
checked any of it: `cm doctor` reported `committed checker none (cm install never run)`, there was
no `.forge/codemap.json`, no `cm verify` in `.github/workflows/`, and no axis in
`.forge/conformance.json` named `cm:`.

## The `cm:edge` decision, and the loss it accepts

`cm:edge` was the better half of the convention. It carries a pointer rather than a sentence, and
it measured accurate: of 773 targets, 753 resolved and not one named a symbol missing from its
target file, the other twenty being a limit of the measurement inside vendored `.forge/archmap/`.
It was removed anyway, and this is the reasoning, recorded here so a later reader can see a
decision rather than an oversight.

Keeping it meant checking it, because an unchecked pointer decays the same way an unchecked
sentence does — just more slowly. Checking it meant a fourteenth gate: a job in `ci-passed`'s
`needs` **and** in its result loop, a `verify.mjs` entry paired by `--ci-parity`, and an axis with
a declared level and baseline direction in `.forge/conformance.json`. ISS-1049 put *adopting `cm`
in this repo as a gate* out of scope, and a hand-rolled equivalent is that same gate under another
name. Between an unchecked pointer and a gate nobody asked for, the annotations went.

**What that costs, said plainly: a coupling between two files in this repo that no type, no path
and no test derives is now written down nowhere.** Three things blunt it and none of them replaces
it — `archmap check` still owns which module may depend on which, an LSP still derives references,
and the couplings that crossed a repository or a language boundary were the ones lifted into
`forge-plugin-coupling.md` and into knowledge entries before the sweep ran. What is gone is the
same-repo, same-language edge: the one `cm`'s own rule says a tool should have derived.

**A document written before 2026-09-16 may still cite a `cm:guard` or a `cm:edge` by name.** Those
citations now point into git history at `33eabd7e` rather than into the tree; `git show 33eabd7e --
<path>` is what resolves one. Every such citation in a live reference document was rewritten in the
same change; the ones left standing are in `docs/proposals/`, which is a record of arguments made
at a date rather than a description of the code as it is.

If that loss is ever felt, the way back is not a new convention. Every removed annotation is in
git at `33eabd7e` (`git show 33eabd7e -- <path>`), and `cm propose --source lockstep|contract`
re-derives candidates from evidence already in the tree.
