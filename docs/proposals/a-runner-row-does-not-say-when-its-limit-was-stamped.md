# A runner row does not say when its limit was stamped

**Status: OPEN, priced by ISS-1060 (2026-09-16). Needs a field on core's runner row, which is the
job lane ISS-1060 put out of scope.**

ISS-1060 built the missing producer for `POST /me/limit`: the box now reads its resident master's
own Claude Code conversation, classifies a refused turn, and tells core. The other half of that
route — `DELETE /me/limit` — lifts the limit when a master's turn succeeds again, because a
successful turn is the only proof an account has recovered.

That clear is authorised by one bit: `limitReason` on `/me/runners`, which says *a limit is being
held for this device* and nothing else. This document is what that bit cannot say.

## The shortfall

Three lanes stamp the same runner row, and they read the same Claude account: the job lane through
`finalize-failure` → `detectRunnerLimit`, the chat lane through `chat-runner-health`, and now the
master lane through `recordMasterLimit`. Any of them may clear it, and that symmetry is correct —
one `~/.claude`, one credential, so a success anywhere is proof for everywhere.

What the box cannot see is **when** the stamp it is about to lift was written. `/me/runners`
carries `rateLimitedForSeconds`, deliberately: it is computed against core's clock so the runner
needs neither a datetime parser nor a skew correction (`me-runners.ts:rateLimitedForSecondsSql`).
The instant is not there, and remaining-seconds does not recover it — a five-hour window with four
hours left is the same number whether it was stamped a minute ago or an hour ago.

So this sequence is representable:

1. A master turn succeeds at `t1`. Nothing is sent: core reports no limit.
2. A job fails at `t2 > t1` on a genuine cap. The job lane stamps the row.
3. The next sweep reads the master's conversation, whose newest decisive record is still the
   success from `t1`, sees `limitReason` set, and sends the `DELETE`.

Older evidence lifts a newer stamp, and the box is back in dispatch against an account that is
still refusing.

## What ISS-1060 did instead

It bounded the window rather than closing it. `daemon::master_limit::CLEAR_WITHIN` is
`NUDGE_REFRESH` — one nudge period — and only a success newer than that may clear. Reporting keeps
the wider `FRESH_WITHIN`, and the asymmetry is deliberate: a late report costs a few wasted turns,
a late clear costs dispatch into a capped account.

That reduces the race to at most one nudge period of wrong dispatch, after which either lane
observes the refusal again and re-stamps. It is carried in the tree as
`cm:hack ISS-1060 until:/me/runners carries the instant a limit was stamped`.

## What would close it

A stamp instant on the runner row, exposed on `/me/runners`, and a `clearMasterLimit` that takes
the observation's own instant and clears only a stamp older than it. That is three files in the job
lane — the schema, `me-runners.ts`, and `master-limit.ts` — plus the runner's `decide` and
`clear_limit`. None of it is large; all of it is outside what ISS-1060 was asked to change, and a
schema change made from an issue that declared no schema coupling is a change nobody reviewed for
that.

## What it is not

It is not a reason to gate the clear on **who** stamped the row. That was proposed twice while
ISS-1060 was being reviewed and is refused on its merits: conditioning on the writer would leave a
box whose account an operator had just fixed stamped until the parsed reset lapsed, which is the
one failure `LIMITED_POLL_INTERVAL` exists as a backoff rather than a blackout to avoid. Temporal
precedence is the thing that is missing; provenance is not.

## Honest costs

What adopting the fix above takes from whoever adopts it.

| Cost | What it means |
|---|---|
| A migration on `runners` | A new column for the stamp instant, on a table every dispatch read joins. The column is nullable and every existing row starts `NULL`, so the first deploy has a window in which no stamp can be ordered and the clear has to fall back to exactly today's behaviour — which means shipping both paths and keeping them until the rows age out. |
| A wider `/me/runners` | The route's whole design is that it sends the runner **remaining seconds** rather than an instant, so the box needs neither a datetime parser nor a skew correction. Adding an instant puts both back on the pacing path, and a box whose clock is wrong now decides limit ordering with it. |
| A conditional `clearMasterLimit` | Core's clear is unconditional today and three lanes call it. Making it conditional for one caller either forks the function or changes what the other two do — and a job's successful clear silently becoming conditional is a much worse bug than the one being fixed. |
| A second observation instant on the wire | `DELETE /me/limit` currently carries no body. It would have to carry the instant of the turn that succeeded, which makes a caller's clock an input to core's decision and gives the route a way to fail that it does not have now. |
| Test surface across two languages | The ordering has to be asserted at the boundary, not inside either half, which means a fixture pair like ISS-1060's for a case that only exists when two lanes race. |
| Work nobody has asked for | The race costs at most one nudge period of wrong dispatch, self-heals, and has never been observed in the field. Paying the five rows above for it is a judgement, not an obvious win. |
