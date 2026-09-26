# Session rows written before the cause set still hold prose in `failure_reason`

**Status:** owed, unbuilt. ISS-1157 took it off the org Overview by folding at read time. The rows
themselves are unchanged.

## The mechanism

Before ISS-877 (2026-08-30), `agent_sessions.failure_reason` held two kinds of value: a cause token,
and whatever sentence `agent-sessions/session-failure.ts` had to hand. That sentence was sometimes an
agent's reply, a runner error or a fragment of the session's own prompt. ISS-877 moved the sentence to
`failure_detail`, and since then every writer in core writes a `FailureCause` (the producer audit is in
ISS-1157's plan). Migration 0192 chose not to backfill: a legacy value reads as `unclassified` through
`pipeline/failure-causes.ts:resolveFailureCause`.

Two readers resolve that way today: `metrics/session-failures-report.ts` and, since ISS-1157,
`me/pulse-folds.ts:foldSessionFailures`. Every other reader of the column still gets the raw value:
`schedules/service.ts` (schedule run list), `pipeline/runs-rollup.ts`, `runners/routes.ts`,
`devices/run-ledger.ts` and the agent-session list. Each of those is scoped to one project, so the
prose stays inside the project that wrote it. A new reader that forgets to resolve would get the
prose too.

## What is owed

A single migration:

- For every row whose `failure_reason` is not in `FAILURE_CAUSES`, keep the value by appending it to
  `failure_detail` (setting it where that is null).
- Then set `failure_reason` to the cause `resolveFailureCause` gives for that value: an alias to its
  target, anything else to `unclassified`.

Nothing is re-classified, so the rule migration 0192 relies on holds: a historical row keeps the
verdict it already reads as, and only where that verdict is stored changes. Once this lands, the
three `LEGACY_CAUSE_ALIAS` entries and the read-time fold can be removed, because the column holds
only the cause set.

## Why ISS-1157 did not do it

Every migration edits `packages/core/drizzle/migrations/meta/_journal.json`. While ISS-1157 was
worked, the ISS-1146 run held that file with its own migration 0309 committed and unlanded. This is
free to build once ISS-1146 lands. Take the number from `node scripts/check-migration-order.mjs`.

## Honest costs

- **Leaving it means every new reader has to remember to resolve.** A reader that groups or shows
  `failure_reason` without `resolveFailureCause` gets the prose back. Nothing refuses that, and the
  only protection is a reviewer who knows this page exists.
- **Taking it moves text between columns for good.** Once the prose is in `failure_detail`, a reader
  that showed it as the reason loses it from that place. Rows that already had a detail hold two
  sentences in one field.
- **Taking it costs a journal slot and one rewrite of an unbounded set of rows.** Nobody has counted
  the legacy rows on beta since 0192 measured 55 prose rows and 1,787 `job_failed`. The statement
  touches all of them in one transaction on a 5.6 GB table.
