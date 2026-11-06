# 0014 — An issue is one outcome, and it closes when its criteria are met in scope

**Status:** accepted · **Date:** 2026-11-07 · **Supersedes:** no earlier ADR. It replaces rules
that lived only in [`CLAUDE.md`](../../CLAUDE.md) "Doing the work" ("Take the complete fix and pay
the larger workload for it", "Old code the work touches is cleaned inside that work", "There is no
'already red' … fix it, whoever caused it") and the reading of `closed` as "the work shipped" in
the served guides.

## Context

The owner's direction of 2026-11-07, relayed by his own session, added these deltas to the loop
[0013](0013-a-person-is-asked-only-for-a-serious-decision.md) already recorded:

- **Aim and measure.** Hand a whole outcome to an agent and get it into use with the least waiting.
  Quality is read on real work by delivery speed and release stability, together.
- **One agent may carry an outcome end to end**: investigate, fix, check, and bring the fix to the
  integration mark. A reviewer or specialist comes in only where the kind of work needs one.
  Authority widens by results.
- **An issue is one verifiable outcome.** The agent splits and groups the work inside it.
- **Verification follows the blast radius**, not the line count.
- **Cleanup stays out of the fix.** "Fix it, whoever caused it" and "clean what you touch" made every
  fix carry unrelated cleanup, which slowed delivery and mixed what a change proved with what it
  tidied.
- **Closing** (owner, 2026-11-07: "ok cho đóng issue khi đạt trong phạm vi", close an issue once it
  is met in scope; "cái nào chưa làm được thì back ra chỗ khác để không sót", whatever could not be
  done is moved elsewhere so nothing is lost).

## Decision

- **An issue is one verifiable outcome.** A separate issue is filed only for priority, a handoff or
  independent tracking; size alone is no reason to split one.
- **The fix does what bounds its own impact or proves it, and nothing else.** A defect seen goes to
  exactly one place: the fix, when the fix needs it; the debt ledger for the Audit, with its
  evidence, when it stands alone; its owner, when it is out of reach. A defect recorded on the
  ledger is discharged to the Audit; one only mentioned in a comment is not.
- **Verification follows the blast radius.** Narrow checks sit next to the fix; wide checks run on
  the integrated build at the release mark, and early where a change touches shared logic,
  billing, permissions or data.
- **Three marks, kept apart.** An issue closes when its criteria are met in scope. Released, and
  confirmed on the target environment, are marks on the release, never issue statuses, so "is it
  live" is read from the release record and never from `closed`. A criterion the issue cannot meet
  is moved out on the record before the close — to the next batch's issue, a new issue or the
  requirement — and the close names where each one went.

## Consequences

- **The kernel lags the decision.** Until ISS-1062 lands, core still makes a close the release's act
  (`CLOSE_ONLY_BY_RELEASE`, `CLOSE_REQUIRES_SHIPPED`, the trigger `trg_issues_closed_means_shipped`).
  The operational texts say so in one clause beginning "today", which that change removes.
- A cleanup a builder would have done in passing now waits for the cleanup window. Where the window
  is off, the debt is recorded and waits longer; where fast delivery is off, the debts door refuses
  it (`FAST_DELIVERY_OFF`) and the issue that met it keeps it.
- A reader who wants to know whether a change is live reads the release, not the issue list.
