# A turn row goes stale when the transcript grows past it

Status: open residual, found by ISS-1020 and out of its scope. Nothing here is implemented.

## What is wrong

`syncTurnsWithMessages` (`packages/core/src/agent-sessions/turns-helpers.ts`) reconciles
`agent_session_turns` with a new `messages` array by comparing lengths first:

- `next.length > prev.length` — insert rows for the new tail entries, and **nothing else**.
- `next.length < prev.length` — delete from `next.length` up.
- equal — walk from the tail and update every row whose content drifted, breaking on the first
  equal one.

Only the third branch notices that an entry already in the table changed. But the derive's own
reducer (`mergeMessages` in `packages/core/src/lib/agent-stream-parser.ts`) rewrites
`messages[messages.length - 1]` in place, so the last entry routinely changes **in the same derive
that appends new ones** — an assistant line continuing the previous one, or a tool result settling a
call. When that happens, the array grows, the first branch runs, and the turn row for the entry that
changed keeps what it held before.

The two copies then disagree for the rest of the session. `agent_sessions.messages` is right;
`agent_session_turns` carries a row whose `content.value` is an earlier state of the same turn,
under an id the transcript no longer uses.

## Evidence

Measured on 2026-09-15 against a real Postgres, at `origin/main` dbe033af and unchanged by
ISS-1020's work, using the fixture in
`packages/core/tests/integration/session-transcript-incremental-e2e.test.ts`: a session derived in
two batches — a `system/init` plus two assistant lines, then a tool result and a `result` line —
ends with `agent_sessions.messages` holding `msg-1, msg-6, msg-7` and `agent_session_turns` holding
`msg-1, msg-3, msg-7`. Turn index 1 is the assistant entry the second batch rewrote.

Both the old full-re-derive path and the new incremental one land there, which is why ISS-1020's
parity case asserts the two agree with each other rather than asserting either is right. The same
sequence derived in ONE pass produces no stale row, so anything that reads the turn table is
sensitive to how the job's events happened to be batched.

## Why it was not fixed there

ISS-1020 put "changing the transcript shape or the turn table" out of scope by name, and the fix
changes what the turn table does on a branch the transcript work never enters.

## What the fix looks like

The growth branch has to do the equal-length branch's work for the entries it is not appending:
before inserting the tail, walk back from `prev.length - 1` updating any row whose content drifted,
breaking on the first equal one — the same O(1)-for-streaming walk that branch already uses.

Two things any such change owes:

- **A second reader of the same disagreement.** Whoever fixes it should say what reads
  `agent_session_turns` today and what a stale row did to it, rather than fixing the symmetry for
  its own sake.
- **A decision about the rows already on disk.** Every session ever derived in more than one batch
  may carry stale turn rows. A backfill that rebuilds them from `agent_sessions.messages` is
  straightforward — that column is the authority — but it is a migration, and this file proposes
  nothing about when.

## Honest costs

- **A backfill, or a documented cut-off.** Every session derived in more than one batch since the
  turn table shipped may carry stale rows, and the fix only stops new ones. Rebuilding the old ones
  is a migration over the largest jsonb column in the schema — `agent_sessions.messages` averages
  233 KB and peaks at 35 MB — so it is a real maintenance window, not a `SET` statement. Choosing
  not to backfill is allowed, but it has to be written down, because a reader who knows only that
  the bug was fixed will trust rows that were never repaired.
- **A write per drifted entry, on the branch that used to do none.** The growth branch currently
  inserts and returns. It would gain the tail walk, which is one UPDATE for each entry that changed
  — one, in the streaming case that dominates, and the walk breaks on the first equal entry. Cheap,
  but it is a write on a path that had none, on the hottest table pair in a live session.
- **A second reader has to be found first.** Nobody has yet said what reads `agent_session_turns`
  and what a stale row did to it. Fixing the symmetry without that answer buys consistency between
  two copies and no stated outcome, and it is the kind of fix that is easy to justify and hard to
  judge afterwards.
