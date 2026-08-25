# ADR: Reopen loop guard

**Status:** SUPERSEDED by [RFC 0002 — Park axis separation](../rfcs/0002-park-axis-separation.md) · 2026-08-14. Mechanisms #2 (the cap) and #3 (model escalation) are both deleted. Only #1 is still live, and what it feeds changed: `reopenCount` now bounds resume and raises an advisory alert, never a cap. The ISS-801 measurements below are the evidence RFC 0002 argues from — keep them.
**Was:** Accepted · 2026-08-11 · ISS-766
**Scope:** what stops a `developed`/`testing` reopen→fix→review cycle from looping indefinitely on one issue, and what happens when it hits the ceiling.

## Problem

Review/test rejections reopen an issue for another fix pass. Nothing bounded how many times that could happen — ISS-801 ran 8 fix + 9 review rounds serially on one issue before a human ever saw it, at opus-tier cost per pass. Root cause and cost data: comments on ISS-766, ISS-764/756.

## Mechanisms

| # | Mechanism | Where | What it does |
|---|-----------|-------|---------------|
| 1 | Counted-reopen predicate **(still live)** | `isReopenEntry` — `packages/core/src/pipeline/state-machine.ts` | Which `from → reopen` hops increment `reopenCount`. The cap it fed is gone; the count now bounds resume (`maxResumeReopenCycles` — `jobs/dispatcher.ts`) and raises the advisory `noProgressRounds` alert (`pipeline/inv7-alarms.ts`). Counts genuine rejections (`developed→reopen`, `testing→reopen`, `tested→reopen`, `closed→reopen`); excludes `reopen→reopen` (already there) and `in_progress→reopen` (a system revert — finalize-failure's retry revert, the reconciler's in-flight wedge reset — not an agent rejection; ISS-766). |
| 2 | ~~Cap escalation~~ **(deleted — RFC 0002 INV-8)** — replaced by a required `reason` on every reopen entry plus an advisory `noProgressRounds` alert. The cap counted reopens, but the thing worth stopping is a reopen that changes nothing, and no counter can tell those apart: on the run below, five rounds each fixed a different blocker. | `REOPEN_CAP = 5` + `transitionIssueStatus` — `packages/core/src/pipeline/state-machine.ts`, `packages/core/src/issues/apply-transition.ts` | At the cap, a **user** actor got the REST 422 `REOPEN_CAP_EXCEEDED` contract (with the project-admin `overrideReopenCap` escape). A **device** actor (every pipeline agent) is redirected to `waiting` instead of throwing: an escalation comment is posted (before the status write), the issue's open run is paused with `pauseReason: reopen_cap:<fromStatus>`, a `pipeline.reopen_cap_escalated` Sentry breadcrumb + `recordReopenCapEscalated()` counter fire, and the MCP result carries `capEscalated`/`requestedStatus` so the calling agent is told the truth instead of believing it set `reopen`. |
| 3 | ~~Model escalation~~ **(deleted — ISS-535, removed when per-stage tiers became fixed)** | was `escalateModel` — `packages/core/src/jobs/stage-overrides.ts` | Bumped `fix`/`review` from sonnet toward opus as `reopenCount` climbed past `ESCALATION_FREE_REOPENS = 1`, on the theory that a harder issue benefits from a stronger model. With every repo-touching stage already at opus the ladder had no rung left to climb, and ISS-766 measured the opus-on-rework loop at $698 of a $1,207 week. A stage's tier is now fixed at dispatch (`cm:guard` on `stage-overrides.ts`), and `stage-overrides.test.ts` asserts the symbol is absent so a re-add cannot land quietly. |

## Before ISS-766

At the cap, `transitionIssueStatus` threw `REOPEN_CAP_EXCEEDED` unconditionally. A device actor's reopen attempt failed, leaving the issue at `developed`/`testing` — an auto-dispatch trigger status — so the reconciler re-enqueued another full-tier review/test job roughly every 60s until the stage-stall guard tripped at 3 consecutive `done` jobs and paused the run with a comment naming the wrong cause (a missing skill on the device). Separately, `isReopenEntry` counted `in_progress → reopen` (the system's own mechanical reverts) as churn, so infra flakes ate cap budget and escalated `fix` to opus for cost that was never a real rejection.

## Operator exits at the cap — both deleted with it

Neither of these exists any more; they are recorded because the escalation comments the cap posted still sit in the issue history, and they name actions the product no longer offers.

- ~~**Override and resume**: a project admin forces the reopen (`overrideReopenCap`, increments the count for real) and resumes the paused run.~~ `overrideReopenCap` is gone from core, REST and the UI. RFC 0002 INV-6 made leaving a park symmetric with entering one, so there is nothing to override: any actor sets the next status through MCP, REST or the UI and the next step dispatches. A run left paused by the cap before the deletion is freed by `resumeOrphanedPauses` (`pipeline/run-pause.ts`, run from the sweeper), which resumes any run whose pause kind this build no longer recognises — not by an operator.
- **Split the issue**: still good advice, and now the only advice — if the churn pattern suggests the issue itself is too large (see ISS-801's ~30-blocker volume), decompose it instead of continuing to reopen the same one. The `noProgressRounds` alert is what surfaces the pattern; nothing forces the split.

## Rejected: complexity-scaled cap

Considered making `REOPEN_CAP` scale with issue complexity (larger cap for `l`/`xl` issues, tighter for `xs`/`s`). Rejected at the time on the grounds that the escalation was a **human gate**, not a hard stop — an operator could already override it or split the issue — so a second tuning axis bought no additional safety and doubled the config surface for no measured benefit. A single global cap, revisited once the new breadcrumb/counter produce real escalation data, was judged sufficient.

## Deliberately out of scope

Retuning `REOPEN_CAP` — deleted; the knob is now `pipelineConfig.reopenPolicy.noProgressRounds` (advisory) — a tuning knob; ISS-766 makes the guard behave correctly at whatever value is set, not what that value should be.

`ESCALATION_FREE_REOPENS` is gone: the reopen-driven model escalation it gated (`escalateModel`) was deleted when per-stage tiers became fixed. `reopenCount` still drives the `maxResumeReopenCycles` resume bound — it no longer drives model choice. See `docs/modules/agents-jobs/prompt-config.md` § Default model-routing policy.
