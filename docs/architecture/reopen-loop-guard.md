# ADR: Reopen loop guard

**Status:** Accepted · 2026-08-11 · ISS-766
**Scope:** what stops a `developed`/`testing` reopen→fix→review cycle from looping indefinitely on one issue, and what happens when it hits the ceiling.

## Problem

Review/test rejections reopen an issue for another fix pass. Nothing bounded how many times that could happen — ISS-801 ran 8 fix + 9 review rounds serially on one issue before a human ever saw it, at opus-tier cost per pass. Root cause and cost data: comments on ISS-766, ISS-764/756.

## Mechanisms

| # | Mechanism | Where | What it does |
|---|-----------|-------|---------------|
| 1 | Counted-reopen predicate | `isReopenEntry` — `packages/core/src/pipeline/state-machine.ts` | Which `from → reopen` hops count against the cap. Counts genuine rejections (`developed→reopen`, `testing→reopen`, `tested→reopen`, `closed→reopen`); excludes `reopen→reopen` (already there) and `in_progress→reopen` (a system revert — finalize-failure's retry revert, the reconciler's in-flight wedge reset — not an agent rejection; ISS-766). |
| 2 | Cap escalation | `REOPEN_CAP = 5` + `transitionIssueStatus` — `packages/core/src/pipeline/state-machine.ts`, `packages/core/src/issues/apply-transition.ts` | At the cap, a **user** actor still gets the REST 422 `REOPEN_CAP_EXCEEDED` contract (with the project-admin `overrideReopenCap` escape). A **device** actor (every pipeline agent) is redirected to `waiting` instead of throwing: an escalation comment is posted (before the status write), the issue's open run is paused with `pauseReason: reopen_cap:<fromStatus>`, a `pipeline.reopen_cap_escalated` Sentry breadcrumb + `recordReopenCapEscalated()` counter fire, and the MCP result carries `capEscalated`/`requestedStatus` so the calling agent is told the truth instead of believing it set `reopen`. |
| 3 | Model escalation | `escalateModel` — `packages/core/src/jobs/stage-overrides.ts` | Independent of the cap: bumps `fix`/`review` from sonnet toward opus as `reopenCount` climbs past `ESCALATION_FREE_REOPENS = 1`, on the theory that a harder issue benefits from a stronger model. Shares mechanism #1's predicate, so it no longer escalates on infra flakes either. |

## Before ISS-766

At the cap, `transitionIssueStatus` threw `REOPEN_CAP_EXCEEDED` unconditionally. A device actor's reopen attempt failed, leaving the issue at `developed`/`testing` — an auto-dispatch trigger status — so the reconciler re-enqueued another full-tier review/test job roughly every 60s until the stage-stall guard tripped at 3 consecutive `done` jobs and paused the run with a comment naming the wrong cause (a missing skill on the device). Separately, `isReopenEntry` counted `in_progress → reopen` (the system's own mechanical reverts) as churn, so infra flakes ate cap budget and escalated `fix` to opus for cost that was never a real rejection.

## Operator exits at the cap

- **Override and resume**: a project admin forces the reopen (`overrideReopenCap`, increments the count for real) and resumes the paused run.
- **Split the issue**: if the churn pattern suggests the issue itself is too large (see ISS-801's ~30-blocker volume), decompose it instead of continuing to reopen the same one.

## Rejected: complexity-scaled cap

Considered making `REOPEN_CAP` scale with issue complexity (larger cap for `l`/`xl` issues, tighter for `xs`/`s`). Rejected: the escalation is a **human gate**, not a hard stop — an operator can already override it or split the issue — so a second tuning axis buys no additional safety and doubles the config surface for no measured benefit. A single global cap, revisited once the new breadcrumb/counter produce real escalation data, was judged sufficient.

## Deliberately out of scope

Retuning `REOPEN_CAP` (5) or `ESCALATION_FREE_REOPENS` (1) — both are tuning knobs; ISS-766 makes the guard behave correctly at whatever value is set, not what that value should be.
