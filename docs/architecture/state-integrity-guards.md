# ADR: State-integrity guard family

**Status:** Accepted · 2026-08-12 · ISS-786
**Scope:** the four guards that stop the pipeline's own status changes from asserting work that never happened — fabricated evidence, phantom advances, plan-less approvals, and unverified diagnostics. VISION [principle #10](../VISION.md#5-principles) ("state never lies") is the invariant these enforce.

## Problem

Four distinct incident shapes shared one root cause — a status write or a diagnostic comment asserted something no query ever checked:

- **A — fabricated evidence.** An agent's own comment released its own `needs_info` bounce, or claimed a human decision that was never made.
- **B — phantom advances.** `developed`/`testing` was reachable with zero branch, commit, or handoff on record (ISS-105, ISS-75–78).
- **C — plan-less approvals.** `approved` was reachable with `plan: null` — reported 7 times across 4 projects.
- **D — unverified diagnostics.** An auto-generated halt comment named a root cause (missing skill sync) it never actually checked.

## Mechanisms

| Group | Guard | Where | What it checks |
|---|---|---|---|
| C | `planRequiredRule` | `packages/core/src/issues/transition-evidence.ts` | Blocks a device-actor write to `approved` when `issues.plan` is blank and the project's plan stage is live (`isPlanStageLive`). |
| C | plan-gate dispatch backstop | `packages/core/src/pipeline/orchestrator.ts` (`considerEnqueue`) + `packages/core/src/pipeline/plan-gate-guard.ts` | Catches issues already sitting at `approved`/`plan:null` from before the writer guard existed — routes to `clarified` (or `needs_info` if a `plan` job already ran and is still blank) and posts an operator comment. (The `reopen`-from-`needs_info` route this guard also performed is deleted with RFC 0002 INV-8 — see row A.) |
| A | ~~`hasHumanAnswerSince`~~ | **deleted — RFC 0002 INV-6** | Was: `needs_info` only released on a comment with `isAi=false AND author_device_id IS NULL`, so an agent's own comment could never count as the human answer it claimed to be. It went with `bounce-replay-guard.ts`. Superseded rather than merely deleted: entering `needs_info` now REQUIRES a `reason`, posted as a comment before the status write. The guard checked the ANSWER's author because the QUESTION was invisible; a question on the record needs no such check, and unlike the guard it cannot strand the issue. |
| B | `noWorkEvidenceRule` / `findMissingWorkEvidence` | `packages/core/src/issues/transition-evidence.ts`, `packages/core/src/pipeline/work-evidence.ts` | Blocks a device-actor write to `developed`/`testing` unless a `code`/`fix` handoff carries `commitSha`/`filesModified`, or `sessionContext.branch` is set. A bare done `code`/`fix` job with an empty handoff is deliberately **not** evidence — that is the exact ISS-105 shape. Decompose parents are exempt (their children carry the code). |
| D | `verifySkillSyncCause` | `packages/core/src/pipeline/stage-stall-guard.ts` | Before naming "missing skill sync" as the cause of a stalled stage, checks `loadDeviceSkillStatus` against the jobs' actual `deviceId`s. Reports `confirmed` (names the non-synced device), `ruled_out` (skill is synced everywhere — cause is something else), or `unverified` (couldn't check) — never a confident guess it didn't check. |

The survivors share the same two invariants:

- **Device-actor-only.** Every rule in `checkTransitionEvidence` runs only for `actorType === 'device'`; a human hand-advance is a recorded human decision, not the fabrication class this guards against. `options.skip === true` (the orchestrator's curated soft-skip/failover chain) is also exempt — it legitimately lands on gated statuses without the evidence a normal write would require.
- **Fail open.** Every guard degrades to "no violation" / "allow" on its own internal error (`checkTransitionEvidence`, `findMissingWorkEvidence`, `checkStageStallAndPause`, `verifySkillSyncCause` all catch-and-log). A broken read must never freeze a legitimate transition — that would turn an integrity guard into a new kind of silent wedge, the exact failure mode principle #10 exists to rule out.

Every refuse path posts an operator-facing comment (`isAi: true`) before or instead of the blocked write — dispatch-gate skips are otherwise silent (no `job_events`), so an unexplained refusal would read as invisible starvation.

## Deliberately unchanged

`markMergedOnClose` (`packages/core/src/issues/merged-at.ts`) still stamps `merged_at` unconditionally on any close whose column is still null — that trade-off was re-litigated and kept (closed = done for the `blocks` gate, by design). Group B only makes the audit comment that already fires on that stamp honest about whether real evidence exists; the stamping behavior itself is untouched (`merged-at.test.ts` unchanged). `closed`/`released` are excluded from `NO_WORK_EVIDENCE_STATUSES` for the same reason — a decompose/coordination epic legitimately reaches them with no branch of its own.

## Composed behavior

`packages/core/tests/integration/state-integrity-guards-e2e.test.ts` walks one issue through all four guards against real Postgres — an agent's self-authored comment fails to release a `needs_info` bounce (A), a human comment does; the writer refuses `approved` with a blank plan (C) until one is written; the writer refuses `developed` with no code evidence (B) until a branch is recorded; three consecutive `done` `review` jobs with no advance trip the stall cap (D), and the halt comment names the cause as unverified rather than asserting a diagnosis it never checked. A second test confirms the same sequence's guards degrade to their safe default (never throw) against an issue that cannot be read.

## Deliberately out of scope

Re-verifying the specific cross-project incident evidence (getcontent/anhome reports) that motivated this epic — the fix is code in `packages/core`, and each gap was confirmed directly against this repo's live source rather than against those reports (see ISS-786 clarify step). Retuning `STAGE_STALL_CAP` (3) — a separate tuning knob. `REOPEN_CAP` is deleted (RFC 0002 INV-8); [reopen-loop-guard.md](reopen-loop-guard.md) is superseded on that point.
