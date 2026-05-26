# Dispatch & Load-Balance Spec v2

Status: DRAFT — all major decisions resolved, ready for code.
Date: 2026-05-26
Decided with: user (ai005@grytt.co)

## Core principles

1. **Serial per project**: 1 issue active tại 1 thời điểm. Fixed.
2. **Primary-pinned**: jobs luôn về `defaultDeviceId` khi nó còn sống.
3. **Failover-only standby**: standby chỉ kích hoạt khi primary `offline` hoặc heartbeat stale. Không load-balance.
4. **Sticky resume**: multi-stage session group pin về device đã start (claude session files là host-local). Pin stale → drop pin, dispatch fresh (KHÔNG migrate).

## CONFIG (DB — runtime editable)

| Knob | Vị trí | Default | Required |
|---|---|---|---|
| `projects.default_device_id` | projects | — | ✅ (không có = không dispatch) |
| `agent_config.pipelineConfig.enabled` | projects | **true** | — |
| `agent_config.pipelineConfig.states[<stage>].sessionGroup` | projects | — | optional |
| `agent_config.pipelineConfig.states[<stage>].enabled` / `.mode` | projects | mode=`auto` | optional |
| `issues.manual_hold` (+ `manual_hold_until`) | per-issue | false | — |
| `issues.merged_at` ← state-machine writes on transition out of `mergeState` | per-issue | NULL | auto-managed |
| `pipelineConfig.mergeStates.baseBranch` | projects | `"released"` | — |
| `pipelineConfig.mergeStates.productionBranch` | projects | `"released"` (trunk-based: = baseBranch) | — |

## FIXED (code constants — redeploy required)

| Constant | Value | Note |
|---|---|---|
| Per-project cap | 1 issue | Hardcoded `DEFAULT_MAX_CONCURRENT_ISSUES=1` |
| Per-runner cap (claude-code) | 1 | Worker model 1-thread |
| Per-runner cap (antigravity) | **1** (was 5) | Unified |
| `dispatchLivenessMs` | 30s | Heartbeat window |
| `MAX_DISPATCH_PER_TICK` | 50 | Burst safety |
| `dispatch-tick` debounce | 1s | Coalesce |
| `pipeline-sweeper` cron | 60s | Backstop |
| `PIPELINE_QUEUE_TIMEOUT_MS` | **120s** (was 5min) | Faster zombie detection |
| `PIPELINE_HEARTBEAT_TIMEOUT_MS` | 180s | Running session liveness |
| `MIN_RETRY_COOLDOWN_MS` | 60s | Retry floor |

## REMOVED

- `pipelineConfig.maxConcurrentIssues` (knob + schema field)
- `pipelineConfig.runnerFallback` (knob + schema field)
- `runners.capabilities.maxConcurrent` per-runner override
- Picker `running_ids` source = `agent_sessions` (replaced by jobs source)
- Selector `RANDOM()` tiebreaker (replaced by deterministic)
- Anti-grav 5-slot CASE branch

## Selector (`selectRunnerForJob`)

```ts
3-step, return first non-null:

  1. pinDeviceId (sticky session group resume)
     healthy → return; stale → null (caller drops resume, dispatches fresh)

  2. defaultDeviceId (primary)
     healthy → return; offline/stale → fallthrough

  3. standby:
     SELECT * FROM runners
     WHERE project_id = $pid
       AND device_id ≠ defaultDeviceId
       AND status = 'online'
       AND last_seen_at > now() - 30s
     ORDER BY last_seen_at DESC, id ASC
     LIMIT 1
```

## Picker (`pickNextDispatchableJobForProject`)

```sql
WITH
  in_flight_issues AS (                 -- ĐỔI: source từ jobs, không phải sessions
    SELECT DISTINCT issue_id
    FROM jobs
    WHERE project_id = $pid
      AND issue_id IS NOT NULL
      AND status IN ('queued','dispatched','running')
      AND (retry_after_at IS NULL OR retry_after_at > now())
  )
SELECT j.*
FROM jobs j
LEFT JOIN issues i ON i.id = j.issue_id
JOIN pipeline_runs r ON r.id = j.pipeline_run_id
WHERE j.status = 'queued'
  AND j.type ≠ 'pm'
  AND r.status = 'running'
  AND (j.retry_after_at IS NULL OR j.retry_after_at <= now())
  AND (i.manual_hold IS NOT TRUE)
  -- L1 same-issue serial
  AND NOT EXISTS (session/job cùng issue chưa terminal)
  -- L2 deps (git-aware — PENDING refinement)
  AND NOT (blockedBy_by_merged_at)
  AND NOT (releaseDecomposePending_by_merged_at)
  -- L3 project cap=1
  AND (
    j.issue_id IN (SELECT issue_id FROM in_flight_issues)
    OR (SELECT COUNT(*) FROM in_flight_issues) < 1
  )
  -- L4 device reachable
  AND (
    (primary healthy AND in_flight=0)
    OR (primary down AND standby healthy AND in_flight=0)
  )
ORDER BY priority, run.started_at, j.queued_at
LIMIT 1
```

## Behavior matrix

| Situation | Primary | Standby | Action |
|---|---|---|---|
| Normal | healthy, free | — | Job → primary |
| Primary busy | healthy, full | healthy, free | **Picker L4 fail** → job ở yên `queued`, wait |
| Primary offline | offline / stale | healthy, free | Picker L4 OK → selector step 3 → standby |
| Primary recover khi standby chạy | back online | running | **Job ở yên trên standby tới terminal**. Job sau → primary. |
| Both down | offline | offline | Picker L4 fail → wait |
| Session crash | healthy, dispatched_job | — | Job vẫn `dispatched` → in_flight_issues vẫn đếm → KHÔNG dispatch tiếp. Stale-detector flip sau 3min → retry. |

## Files to change

| # | File | Type |
|---|---|---|
| 1 | `packages/core/drizzle/migrations/00XX_add_issues_merged_at.sql` | migration |
| 2 | `packages/core/src/db/schema.ts` | schema |
| 3 | `packages/core/src/jobs/dispatch-gates.ts` | logic |
| 4 | `packages/core/src/runners/select.ts` | logic |
| 5 | `packages/core/src/pipeline/pipeline-config-schema.ts` | schema (remove fields, default `enabled=true`) |
| 6 | `packages/core/src/pipeline/sweeper.ts` | constant (`PIPELINE_QUEUE_TIMEOUT_MS=120_000`) |
| 7 | `packages/core/src/issues/state-machine.ts` (or wherever `transitionIssue` lives) | write `merged_at` on transition out of `mergeState` |
| 7b | Pipeline prompt builder | inject merge-required text block when stage matches `mergeStates.*` |
| 8 | Tests update: `dispatch-gates.test.ts`, `select.test.ts`, `sweeper.test.ts`, `pipeline-config-schema.test.ts` | tests |
| 9 | Tests new: `merged-at-backfill.test.ts`, `dep-merge-gate.test.ts` | tests |

## Commit plan

Recommend: C → B
- **C**: revert commit `72425e6f` (the load-balance fix in wrong direction)
- **B**: 3 small PRs:
  1. add `merged_at` + backfill + L2 gate change
  2. picker `in_flight_issues` + selector refactor
  3. drop removed configs + antigravity cap

---

## L2 deps — config-driven merge gating (RESOLVED)

### Design

L2 unlock dựa **state machine** (issue.status), không phải DB writer trong skill code. Operator config "state nào chịu trách nhiệm merge" → state machine tự đánh dấu `merged_at` khi issue transition OUT của state đó. Skill chỉ cần làm đúng việc (merge code) — prompt được inject text yêu cầu merge để skill biết phải làm.

### New config

```jsonc
// projects.agent_config.pipelineConfig.mergeStates
{
  "baseBranch":       "released",  // state nào merge vào baseBranch
  "productionBranch": "released"   // state nào merge vào productionBranch (trunk-based: cùng state)
}
```

| Key | Default | Tác dụng |
|---|---|---|
| `mergeStates.baseBranch` | `"released"` | State machine set `merged_at` khi issue rời state này. `blockedBy` L2 gate dùng giá trị này. |
| `mergeStates.productionBranch` | `"released"` | (Multi-branch project) State merge production. `releaseDecomposePending` L2 gate dùng. Trunk-based = trùng baseBranch. |

### Prompt injection

Khi dispatcher build prompt cho 1 job mà `job.stageStatus == project.pipelineConfig.mergeStates.baseBranch` (hoặc productionBranch):

Inject block **đầu prompt** (priority cao hơn skill default — chỉ text, không cần code priority system):

```text
## Merge required (this stage)

This stage is configured as the merge point for the project's `baseBranch`.
Before transitioning the issue forward you MUST:

1. Ensure ISS-XX branch is fully committed and pushed to origin
2. `git checkout <baseBranch> && git pull origin <baseBranch>`
3. `git merge --no-ff origin/ISS-XX-...` (or fast-forward if linear)
4. `git push origin <baseBranch>`
5. Verify the merge commit exists on remote before issuing the final status transition

Failure to complete the merge means downstream issues (blocks/decomposes) will
never unlock. If the merge fails, do NOT advance the issue status — keep it on
`<this state>` and post a comment with the failure reason.
```

(Cùng pattern cho `productionBranch` nếu khác state.)

### State-machine writer

Trong `transitionIssue(issueId, newStatus)`:

```ts
// Sau khi UPDATE issues.status thành công, trong cùng transaction:
const project = await getProject(issue.projectId);
const baseMergeState  = project.pipelineConfig?.mergeStates?.baseBranch  ?? 'released';

if (issue.previousStatus === baseMergeState && newStatus !== baseMergeState) {
  // Issue đã rời state merge → đánh dấu
  await db.update(issues)
    .set({ mergedAt: now() })
    .where(and(eq(issues.id, issueId), isNull(issues.mergedAt)));
}
```

Idempotent qua `WHERE mergedAt IS NULL`. Crash giữa skill run và status transition → nothing happens (parent vẫn block child, đúng).

### L2 gates (final)

```sql
-- blockedBy: parent của kind='blocks' phải đã merged
NOT EXISTS (
  SELECT 1 FROM issue_dependencies d
  JOIN issues p ON p.id = d.from_issue_id
  WHERE d.to_issue_id = j.issue_id
    AND d.kind = 'blocks'
    AND (d.valid_until IS NULL OR d.valid_until > now())
    AND p.merged_at IS NULL
)

-- releaseDecomposePending: child 'release' job chờ parent decomposes merged
NOT (j.type = 'release' AND EXISTS (
  SELECT 1 FROM issue_dependencies d2
  JOIN issues p2 ON p2.id = d2.from_issue_id
  WHERE d2.to_issue_id = j.issue_id
    AND d2.kind = 'decomposes'
    AND (d2.valid_until IS NULL OR d2.valid_until > now())
    AND p2.merged_at IS NULL
))
```

### Schema migration

```sql
ALTER TABLE issues ADD COLUMN merged_at timestamptz NULL;
CREATE INDEX issues_merged_at_idx ON issues (merged_at) WHERE merged_at IS NOT NULL;

-- Backfill: any issue ever `released` or `closed` (assume legacy = merged or doesn't matter)
UPDATE issues SET merged_at = updated_at
WHERE status IN ('released','closed') AND merged_at IS NULL;
```

### Trunk-based assumption (jarvis-agents + Anhome)

`baseBranch == productionBranch`. 1 column `merged_at` đủ. Cả 2 gate (`blocks`, `releaseDecomposePending`) dùng chung.

Khi multi-branch (future): cần thêm `issues.merged_to_prod_at` riêng. KHÔNG làm trong v2.

### Manual override

Operator có button "Mark as merged" trên issue UI → `UPDATE issues SET merged_at = now() WHERE id = $1`. Dùng cho:
- Abandoned issue dependency cần unblock children
- Migration từ legacy data thiếu sót
- Non-code issues (docs/ops) không qua mergeState nhưng vẫn cần unblock children

### Resolved answers

| # | Câu hỏi | Quyết định |
|---|---|---|
| 1 | Non-code issues exempt | Không tách field `requires_merge`. Issue không qua mergeState → `merged_at` NULL → children wait. Operator dùng "Mark as merged" manual nếu cần unblock. |
| 2 | Crash recovery | Writer là **state-machine**, không phải skill. Crash giữa merge và status transition = không set `merged_at` (đúng — parent chưa thật sự xong). Skill phải verify push trước khi transition. |
| 3 | Cross-project blocks | `merged_at` per-issue toàn cục, mỗi project tự config mergeState. Hoạt động xuyên project. |
| 4 | Manual-close abandoned | Status transition trực tiếp sang `closed` từ state ≠ mergeState → `merged_at` NULL → children wait. Manual override available. |
| 5 | Multi-base-branch | Defer. Trunk-based v2 dùng 1 column. Future: thêm `merged_to_prod_at`. |
| 6 | `manual_hold_until` interaction | Không đụng — L2 gate vẫn block sau khi manual_hold tự clear nếu parent chưa merged. Correct behavior. |
