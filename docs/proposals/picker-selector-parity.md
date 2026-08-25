# The picker and the selector filter on different clauses

**Status:** open residual, recorded 2026-08-25. Not the cause of the forge-dev outage that surfaced it
(that was a SQL rendering bug in `poolClause`, fixed in `aea4a9dd` — see ISS-858), and not fixed by it.

## The asymmetry

Two pieces of code decide whether a job can run, and they do not agree:

| | Where | Answers |
|---|---|---|
| picker | `jobs/dispatch-gates.ts` — the `fresh_capable_runners` CTE | "is this job dispatchable?" → drives `gateReason` |
| selector | `runners/select.ts` — `poolClause` and friends | "which runner takes it?" → returns a runner or `null` |

The CTE has **no per-state device-pool predicate**. `selectRunnerForJob` has one
(`pipelineConfig.states[<stage>].deviceIds`). So on a project that pins a stage to a subset of its
fleet, the picker counts every online runner while the selector counts only the pinned ones.

When every pinned device is offline but some unpinned one is up, the picker declares the job
dispatchable, `selectRunnerForJob` returns `null`, `handleDispatch` logs and returns `'skipped'`, and
the row sits `queued` with `gateReason: null` — dispatchable by every gate it reports on, reachable by
nothing. Nothing in any UI can name a reason, because there is no reason to name.

The `cm:guard` on `fresh_capable_runners` already states the rule this violates: *every clause
`runners/select.ts` filters on MUST appear here too, or the pair deadlocks silently.* It was measured
on 2026-08-14 at 11 jobs across 5 projects sitting 6–22 days.

## Why it is recorded rather than fixed

The forge-dev outage it was suspected of causing had a different cause one layer down, and ISS-858
closed on that fix — verified live. This asymmetry survives it: a pool whose members are all offline
still produces the silent shape above. It is a real defect with no current victim.

## What closing it looks like

1. Mirror the pool predicate into `fresh_capable_runners`, and add a `pool_empty` arm to the
   `gateReason` CASE so the condition has a name.
2. A test that fails when either side gains a clause the other lacks — the parity itself asserted,
   not just today's clause list. Without it the pair drifts apart again on the next filter added.
3. `gateReason: null` on a job no runner can be selected for should be impossible by construction,
   not by review.
