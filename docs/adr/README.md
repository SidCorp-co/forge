# Architecture Decision Records

One file per decision: what was decided, the context it was decided in, and what it costs.

## The convention

- **An accepted ADR's decision is immutable.** A later decision is a **new** ADR that supersedes or
  amends the old one by number; the old one keeps standing and carries one line saying which ADR
  superseded or amended it. Editing a past decision to match the present destroys the only record of
  why the present was chosen.
- **What an accepted ADR may take as an edit** is what changes no decision: that one
  superseded-by or amended-by line, a citation corrected for a file or symbol that moved, tense, and
  something the decision already named, named more exactly — the identifier of an issue it
  described, say. Anything that adds a decision or changes one is a new ADR.
- **Numbered `NNNN-kebab-title.md`**, allocated in order, never reused.
- **A rule belongs in the document that owns it** — [`CONTRIBUTING.md`](../../CONTRIBUTING.md),
  [`GOVERNANCE.md`](../../GOVERNANCE.md), [`CLAUDE.md`](../../CLAUDE.md) or
  [`scripts/README.md`](../../scripts/README.md). An ADR records that the rule was **adopted** and
  why. Conflating the two produces either a rule nobody can date or a history that never says what
  is currently in force.

## On the numbering, and an earlier series

This directory is the series of record from `0001`. Readers will meet citations to a different
series: the project's tracker knowledge cites **"ADR 0014"** for the branch name `ISS-<seq>-<slug>`.
Searched on 2026-09-27 at `7a377691e`: no document of that series exists under `docs/adr/` here,
and none in the installed `forge-plugin` copy — `grep -rl 0014` over
`~/.config/forge-runner/marketplaces/SidCorp-co__forge-plugin/plugin`, whose `plugin.json` read
`3.36.192`, matched no `.md` file. The citation resolves to nothing readable. It is recorded here
so a reader stops looking, and so nobody reads `0014` in this directory, when it is allocated, as
that citation's target.

## The edits ADR 0003 took after it was accepted

ADR 0003 was accepted at `31d4b826f` and edited seven times afterwards. Six changed no decision
and stand as edits:

| Commit | Edit | Kind |
|---|---|---|
| `6faf9c58e` | the amnesty's end condition, already a forge-plugin issue closing, names which readers that issue moves, and says its number is not yet allocated | clarification |
| `154b42f9c` | a citation corrected for a symbol that moved | clarification |
| `3e9b50b6e` | the amnesty names `ISS-2745`, the issue its end condition described | clarification |
| `1b455cffa` | the context put in the past tense, and a citation corrected for a file that moved | clarification |
| `4f0652fb4` | a pointer dropped from a file that no longer holds the measurement | clarification |
| `266bf8fe1` | the amended-by line naming ADR 0005, and the context restored to its accepted wording, in the past tense `1b455cffa` gave it, undoing `4c52ec218`'s rewrite | amended-by line |

One, `4c52ec218`, added a decision — that `base_branch` stays — and rewrote the context to
match. That decision is [ADR 0005](0005-base-branch-stays-beside-the-release-chain.md) now; ADR
0003's context reads as it was accepted, and its amended-by line points there.
