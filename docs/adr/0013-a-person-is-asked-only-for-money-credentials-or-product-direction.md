# 0013 — A person is asked only for money, credentials or product direction

**Status:** accepted · **Date:** 2026-11-07 · **Supersedes:** the three stops in
[`GOVERNANCE.md`](../../GOVERNANCE.md) "What an agent decides alone" (a destructive migration, an
expensive ambiguity, a failure with no way back), which no earlier ADR recorded

## Context

`GOVERNANCE.md` listed three things that stopped an agent and asked a person. Each was a routine
approval in practice: the agent had the evidence and the options, and the person read them and said
yes. The owner ruled that this is the wrong shape:

- 2026-10-31: agents decide and execute, on the record; humans set policy, and a person is brought in
  only for a decision serious enough to need one.
- 2026-11-06: "từ khi nào mà forge trở nên rắc rối và bắt tôi đi duyệt nhiều vậy" (since when did
  Forge become this complicated and make me approve so much) — a routine approval is a defect, not a
  safeguard.
- 2026-11-07: the loop is Product → Delivery → Release → Audit → Product, and every text that speaks
  to direction is rewritten to agree with it.

## Decision

- **An agent decides and records.** Each decision is written on the item it shapes — what was chosen,
  the options, why, and the evidence — so a person can read and reverse it.
- **A person is asked only for money, credentials or product direction**, once, with a
  recommendation (`VISION: route-judgment-not-bottlenecks`).
- **A person's act that is a kernel step stays one**: granting a credential, approving a device's
  pairing, approving a release where the project asks for that approval. Who may approve is a
  permission ([0007](0007-approval-is-a-permission.md)), and an agent holding it approves.
- **The former stops are decided on the record**: a destructive migration states on its issue what
  it loses before it lands; an ambiguity is settled by the reading the requirement supports, with the
  other reading recorded; a failure with no way back is reported on its issue and escalated, with
  what was tried.

## Consequences

- A person reads decisions after the fact more often than before them. A wrong one is reversed from
  its record, and the lesson it teaches is stored for retrieval.
- A destructive migration can land without anyone having said yes. Its issue says what it lost, and
  that sentence is the only warning a reader gets.
- A project that wants a person on more decisions sets that as policy (`strict`) and pays in waiting.
