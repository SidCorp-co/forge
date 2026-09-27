# Architecture Decision Records

One file per decision: what was decided, the context it was decided in, and what it costs.

## The convention

- **An ADR is immutable.** A decision that changes gets a **new** ADR superseding the old one by
  number; the old one keeps standing and says which ADR replaced it. Editing a past decision to
  match the present destroys the only record of why the present was chosen.
- **Numbered `NNNN-kebab-title.md`**, allocated in order, never reused.
- **A rule belongs in the document that owns it** — [`CONTRIBUTING.md`](../../CONTRIBUTING.md),
  [`GOVERNANCE.md`](../../GOVERNANCE.md), [`CLAUDE.md`](../../CLAUDE.md) or
  [`scripts/README.md`](../../scripts/README.md). An ADR records that the rule was **adopted** and
  why. Conflating the two produces either a rule nobody can date or a history that never says what
  is currently in force.

## On the numbering, and an earlier series

This directory is the series of record from `0001`. Readers will meet citations to a different
series: the project's tracker knowledge cites **"ADR 0014"** for the branch name `ISS-<seq>-<slug>`.
Searched on 2026-09-27 at `7a377691e`, no document of that series exists in this repository or in
the installed `forge-plugin` copy — the citation resolves to nothing readable. It is recorded here
so a reader stops looking, and so nobody reads `0014` in this directory, when it is allocated, as
that citation's target.
